// Ridge Quest Home redesign (2026-10-06): the 3D today picture (frontend/rq-hero.js) on top,
// redrawn only when boarding the gondola; consolidated layout; Guard off Home; conditions page
// "Start tracking".
// Run: `node --test tests/rq-home.test.js` (or the full suite).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const H = require("../frontend/rq-hero.js");
const rq = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8").replace(/\r/g, "");

// A main lift (gondola, climbs 1068 m, drawn bottom->top) and a chair (climbs 350 m).
const gondola = { zoneId: "g", runType: "lift", climbM: 1068, descentM: 2, path: [[51.297, -116.955], [51.287, -117.03]] };
const chair = { zoneId: "c", runType: "lift", climbM: 350, descentM: 0, path: [[51.29, -117.06], [51.285, -117.07]] };
const cors = [gondola, chair, { zoneId: "x", runType: "chute", path: [[51.28, -117.05], [51.279, -117.051]] }];
const north = m => m / 111320;

test("boarding the main lift at its bottom station triggers; the top station and other lifts don't", () => {
  assert.strictEqual(H.mainLift(cors).lift, gondola, "the lift that climbs the most");
  assert.strictEqual(H.isMainLiftBoarding([51.297 + north(100), -116.955], cors), true, "100 m from the bottom station");
  assert.strictEqual(H.isMainLiftBoarding([51.287, -117.03], cors), false, "getting on at the top (to ride down) is not 'the bottom of the hill'");
  assert.strictEqual(H.isMainLiftBoarding([51.29, -117.06], cors), false, "another chair");
  const drawnDown = Object.assign({}, gondola, { climbM: 2, descentM: 1068, path: gondola.path.slice().reverse() });
  assert.strictEqual(H.isMainLiftBoarding([51.297, -116.955], [drawnDown]), true, "bottom found by elevation when drawn top->bottom");
  assert.strictEqual(H.isMainLiftBoarding([51.297, -116.955], []), false, "no lifts -> never");
});

test("a picture is fresh only for today and when not stale", () => {
  assert.strictEqual(H.isFreshFor({ img: "x", day: "2026-12-01" }, "2026-12-01"), true);
  assert.strictEqual(H.isFreshFor({ img: "x", day: "2026-11-30" }, "2026-12-01"), false, "yesterday's -> draw today's");
  assert.strictEqual(H.isFreshFor({ img: "x", day: "2026-12-01", stale: true }, "2026-12-01"), false, "asked for while locked");
  assert.strictEqual(H.isFreshFor(null, "2026-12-01"), false);
});

test("refresh: at most one gondola redraw per 10 minutes; a locked phone marks it stale", async () => {
  const store = {};
  global.localStorage = { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } };
  global.document = { hidden: true };
  H.state.lastAt = 0;
  const r1 = await H.refresh("p1", "gondola", async () => ({}), "2026-12-01");
  assert.strictEqual(r1, "stale");
  assert.ok(JSON.parse(store["rq.hero.p1"]).stale, "remembered for the next Home open");
  const r2 = await H.refresh("p1", "gondola", async () => ({}), "2026-12-01");
  assert.strictEqual(r2, "skipped", "a second boarding within 10 min does nothing");
  delete global.document; delete global.localStorage;
});

test("Home: picture on top, Start tracking under it, strips, grid, account folded; no Guard button", () => {
  const home = rq.slice(rq.indexOf("function renderHome(){"), rq.indexOf("// The rider's own chute names (cached copy"));
  const order = ['id="heroBox"', 'id="btnTrack"', '<h3>Today</h3>', '<h3>This season</h3>', 'class="exploreGrid"', 'id="todayRuns"', 'details class="acct"'];
  let last = -1;
  order.forEach(k => { const i = home.indexOf(k); assert.ok(i > last, k + " in order"); last = i; });
  assert.ok(!/btnGuard/.test(home), "Guard switch is on My map only");
  assert.ok(/paintHero\(s\);/.test(home), "the picture is painted on every Home open");
  assert.ok(/<script src="\/rq-hero\.js"><\/script>/.test(rq));
});

test("the picture redraws when boarding the gondola (from the GPS handler), not on its own", () => {
  assert.ok(/RQHero\.isMainLiftBoarding\(\[fix\.lat, fix\.lon\], this\.corridors\)\) this\.onGondolaBoard\(\)/.test(rq));
  assert.ok(/Quest\.onGondolaBoard = \(\)=>\{ heroRefresh\(getSession\(\), "gondola"\); \};/.test(rq));
  const paint = rq.slice(rq.indexOf("function paintHero(s){"), rq.indexOf("Quest.onGondolaBoard = "));
  assert.ok(/if\(!RQHero\.isFreshFor\(cached, questDateBucketClient\(new Date\(\)\)\)\) heroRefresh/.test(paint), "Home only draws it when there is none for today");
});

test("conditions page: Start tracking replaces Continue (Back while tracking), with a look-around link", () => {
  const c = rq.slice(rq.indexOf("async function renderConditions(onContinue, onStart){"), rq.indexOf("function startTrackingFromConditions(){"));
  assert.ok(/'<button class="primary trackBtn" id="btnCont">Start tracking<\/button>/.test(c));
  assert.ok(/id="btnCont">Back<\/button>/.test(c) && /id="btnLookAround"/.test(c));
  assert.ok(/renderConditions\(renderHome, startTrackingFromConditions\);/.test(rq), "boot path");
  const s = rq.slice(rq.indexOf("function startTrackingFromConditions(){"));
  assert.ok(/renderHome\(\);[\s\S]{0,80}b\.click\(\)/.test(s.slice(0, 300)), "same tap starts tracking on Home");
});

test("Share my location is on the Friends screen, not Home; sending still runs from any screen", () => {
  const home = rq.slice(rq.indexOf("function renderHome(){"), rq.indexOf("// The rider's own chute names (cached copy"));
  assert.ok(!/btnShare/.test(home), "not on Home");
  const friends = rq.slice(rq.indexOf("async function renderFriends(){"));
  assert.ok(/id="btnShare"/.test(friends.slice(0, 1200)) && /bindShareButton\(document\.getElementById\("btnShare"\)\);/.test(friends.slice(0, 2500)));
  assert.ok(/api\("\/api\/share", \{method:"POST", body:JSON\.stringify\(\{on:turningOn\}\)\}\)/.test(rq.slice(rq.indexOf("function bindShareButton(btn){"))));
  assert.ok(/Quest\.onShare = \(p\)=>\{/.test(rq), "the location POST piggyback is still set up");
});
