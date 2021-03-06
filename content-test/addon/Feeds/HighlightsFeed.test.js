const {TOP_SITES_DEFAULT_LENGTH, HIGHLIGHTS_LENGTH} = require("common/constants");
const moment = require("moment");
const {SimplePrefs} = require("sdk/simple-prefs");

const simplePrefs = new SimplePrefs();
const testLinks = [{url: "foo.com"}, {url: "bar.com"}];
const oldTestLinks = [{url: "boo.com"}, {url: "far.com"}];
const getCachedMetadata = links => links.map(
  link => { link.hasMetadata = true; return link; }
);
const PlacesProvider = {
  links: {
    getAllHistoryItems: sinon.spy(() => Promise.resolve(testLinks)),
    getRecentlyVisited: sinon.spy(() => Promise.resolve(testLinks)),
    getHighlightsLinks: sinon.spy(() => Promise.resolve(oldTestLinks))
  }
};
const testScreenshot = "screenshot.jpg";

class Recommender {
  constructor(...args) {
    this.args = args;
  }
}
const createStoreWithState = state => ({
  state,
  getState() {
    return this.state;
  }
});

describe("HighlightsFeed", () => {
  let HighlightsFeed;
  let instance;
  let reduxState;
  beforeEach(() => {
    HighlightsFeed = require("inject!addon/Feeds/HighlightsFeed")({
      "addon/PlacesProvider": {PlacesProvider},
      "sdk/simple-prefs": simplePrefs,
      "common/recommender/Recommender": {Recommender},
      "addon/lib/getScreenshot": sinon.spy(() => testScreenshot)
    });
    Object.keys(PlacesProvider.links).forEach(k => PlacesProvider.links[k].reset());
    instance = new HighlightsFeed({getCachedMetadata});
    instance.refresh = sinon.spy();
    reduxState = {Experiments: {values: {}}};
    instance.store = {getState() { return reduxState; }};
    sinon.spy(instance.options, "getCachedMetadata");
  });
  it("should create a HighlightsFeed", () => {
    assert.instanceOf(instance, HighlightsFeed);
  });
  it("should have an UPDATE_TIME of 15 minutes", () => {
    const time = moment.duration(HighlightsFeed.UPDATE_TIME);
    assert.equal(time.minutes(), 15);
  });
  describe("#getCoefficientsFromPrefs", () => {
    it("should return coefficients from prefs", () => {
      simplePrefs.prefs.weightedHighlightsCoefficients = "[0, 1, 2]";
      assert.deepEqual(instance.getCoefficientsFromPrefs(), [0, 1, 2]);
    });
    it("should return null if there were parsing errors", () => {
      simplePrefs.prefs.weightedHighlightsCoefficients = "not valid";
      assert.isNull(instance.getCoefficientsFromPrefs());
    });
    it("should return null if the pref does not return an array", () => {
      simplePrefs.prefs.weightedHighlightsCoefficients = "{}";
      assert.isNull(instance.getCoefficientsFromPrefs());
    });
  });
  describe("#initializeRecommender", () => {
    it("should return a promise", () => {
      assert.instanceOf(instance.initializeRecommender(), Promise);
    });
    it("should set .baselineRecommender", () =>
      instance.initializeRecommender().then(() =>
        assert.instanceOf(instance.baselineRecommender, Recommender)
      )
    );
    it("should pass the right args", () => {
      simplePrefs.prefs.weightedHighlightsCoefficients = "[0, 1, 2]";
      return instance.initializeRecommender().then(() => {
        assert.equal(instance.baselineRecommender.args[0], testLinks);
        assert.deepEqual(instance.baselineRecommender.args[1], {
          experiments: reduxState.Experiments.values,
          highlightsCoefficients: [0, 1, 2]
        });
      });
    });
    it("should call refresh with the reason", () => {
      instance.refresh = sinon.spy();
      return instance.initializeRecommender("foo").then(() => {
        assert.calledWith(instance.refresh, "foo");
      });
    });
  });
  describe("#getData", () => {
    it("should reject if baselineRecommender is undefined", () => instance.getData()
        .catch(e => {
          assert.instanceOf(e, Error);
          assert.equal(e.message, "Tried to get weighted highlights but there was no baselineRecommender");
        })
    );
    it("should resolve with a HIGHLIGHTS_RESPONSE action if there are weighted highlights", () => {
      instance.baselineRecommender = {scoreEntries: links => links};
      return instance.getData()
        .then(action => {
          assert.isObject(action);
          assert.equal(action.type, "HIGHLIGHTS_RESPONSE");
          assert.lengthOf(action.data, 2);
        });
    });
    it("should run sites through getCachedMetadata", () => {
      instance.baselineRecommender = {scoreEntries: links => links};
      return instance.getData()
        .then(action => {
          assert.calledOnce(instance.options.getCachedMetadata);
          assert.deepEqual(action.data, getCachedMetadata(testLinks));
        });
    });
    it("should run sites through scoreEntries AFTER getCachedMetadata", () => {
      instance.baselineRecommender = {scoreEntries: sinon.spy(links => links)};
      return instance.getData()
        .then(action => (
          assert.calledWithExactly(instance.baselineRecommender.scoreEntries, getCachedMetadata(testLinks))
        ));
    });
    it("should not add screenshots to sites that don't qualify for a screenshot", () => {
      instance.baselineRecommender = {scoreEntries: sinon.spy(links => links)};
      instance.shouldGetScreenshot = () => false;
      return instance.getData().then(result => {
        assert.notCalled(instance.getScreenshot);
        for (let link of result.data) {
          assert.equal(link.screenshot, undefined);
        }
      });
    });
    it("should add screenshots to sites that qualify for a screenshot", () => {
      instance.baselineRecommender = {scoreEntries: sinon.spy(links => links)};
      instance.shouldGetScreenshot = () => true;
      return instance.getData().then(result => {
        assert.calledTwice(instance.getScreenshot);
        for (let link of result.data) {
          assert.equal(link.screenshot, testScreenshot);
          assert.notEqual(link.metadata_source.indexOf("+Screenshot"), -1);
        }
      });
    });
    it("should set missingData to true if a topsite is missing a required screenshot", () => {
      instance.baselineRecommender = {scoreEntries: sinon.spy(links => links)};
      instance.shouldGetScreenshot = () => true;
      instance.getScreenshot = sinon.spy(site => null);
      return instance.getData().then(result => {
        assert.equal(instance.missingData, true);
      });
    });
    it("should set missingData to true if a highlight is missing metadata", () => {
      instance.baselineRecommender = {scoreEntries: sinon.spy(links => links)};
      instance.options.getCachedMetadata = links => links.map(
        link => { link.hasMetadata = false; return link; }
      );
      return instance.getData().then(result => {
        assert.equal(instance.missingData, true);
      });
    });
  });
  describe("#onAction", () => {
    let clock;
    let store;
    beforeEach(() => {
      instance.refresh = sinon.spy();
      instance.baselineRecommender = {scoreEntries: sinon.spy(links => links)};
      clock = sinon.useFakeTimers();
      store = createStoreWithState({});
      instance.connectStore(store);
    });
    afterEach(() => {
      clock.restore();
    });
    it("should call refresh on APP_INIT", () => {
      instance.initializeRecommender = sinon.spy();
      instance.onAction(store.getState(), {type: "APP_INIT"});
      assert.calledWith(instance.initializeRecommender, "app was initializing");
    });
    it("should call refresh on RECEIVE_BOOKMARK_ADDED", () => {
      instance.onAction({}, {type: "RECEIVE_BOOKMARK_ADDED"});
      assert.calledOnce(instance.refresh);
      assert.calledWith(instance.refresh, "a bookmark was added");
    });
    it("should call refresh on METADATA_UPDATED if there are not enough sites", () => {
      store.state.Highlights = {rows: Array(HIGHLIGHTS_LENGTH + TOP_SITES_DEFAULT_LENGTH - 1).fill("site")};
      instance.onAction(store.getState(), {type: "METADATA_UPDATED"});
      assert.calledOnce(instance.refresh);
      assert.calledWith(instance.refresh, "new metadata is available and there were not enough sites");
    });
    it("should not call refresh on METADATA_UPDATED if there are enough sites", () => {
      store.state.Highlights = {rows: Array(HIGHLIGHTS_LENGTH + TOP_SITES_DEFAULT_LENGTH).fill("site")};
      instance.onAction(store.getState(), {type: "METADATA_UPDATED"});
      assert.notCalled(instance.refresh);
    });
    it("should call refresh on METADATA_UPDATED if .lastUpdated is too old", () => {
      store.state.Highlights = {rows: Array(HIGHLIGHTS_LENGTH + TOP_SITES_DEFAULT_LENGTH).fill("site")};
      instance.lastUpdated = 0;
      clock.tick(HighlightsFeed.UPDATE_TIME);
      instance.onAction(store.getState(), {type: "METADATA_UPDATED"});
      assert.calledOnce(instance.refresh);
      assert.calledWith(instance.refresh, "new metadata is available and the sites were too old");
    });
    it("should not call refresh on METADATA_UPDATED if .lastUpdated is less than update time", () => {
      store.state.Highlights = {rows: Array(HIGHLIGHTS_LENGTH + TOP_SITES_DEFAULT_LENGTH).fill("site")};
      instance.lastUpdated = 0;
      clock.tick(HighlightsFeed.UPDATE_TIME - 1);
      instance.onAction(store.getState(), {type: "METADATA_UPDATED"});
      assert.notCalled(instance.refresh);
    });
    it("should update the coefficients if the weightedHighlightsCoefficients pref is changed", () => {
      instance.initializeRecommender = sinon.spy();
      instance.onAction(store.getState(), {type: "PREF_CHANGED_RESPONSE", data: {name: "weightedHighlightsCoefficients"}});
      assert.calledWith(instance.initializeRecommender, "coefficients were changed");
    });
    it("should call refresh on SYNC_COMPLETE", () => {
      instance.onAction({}, {type: "SYNC_COMPLETE"});
      assert.calledOnce(instance.refresh);
      assert.calledWith(instance.refresh, "new tabs synced");
    });
    it("should call refresh on MANY_LINKS_CHANGED", () => {
      instance.onAction({}, {type: "MANY_LINKS_CHANGED"});
      assert.calledOnce(instance.refresh);
      assert.calledWith(instance.refresh, "frecency of many links changed");
    });
  });
});
