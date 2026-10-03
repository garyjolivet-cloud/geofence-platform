// Guard defaults (2026-10-03): the Fence Editor's ⚙ → "🛡 Guard defaults" list of overlapping
// chutes/runs (frontend/guard-overlap.js) and the zone.guardDefaultOff field it sets, which must
// survive all three zone mirrors (Publish, reload, Test Mode) and reach Ridge Quest.
//
// Run: `node --test tests/guard-defaults.test.js` (or the full suite).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const GO = require("../frontend/guard-overlap.js");

const LON0 = -117.05, LAT0 = 51.30;
const east = m => LON0 + m / (111320 * Math.cos(LAT0 * Math.PI / 180));
const north = m => LAT0 + m / 111320;
// a straight north-south line `x` m east, drawn top (north) to bottom
const line = (x, lenM) => { const p = []; for (let y = lenM; y >= 0; y -= 20) p.push([east(x), north(y)]); return p; };
const C = (id, x, widthM, extra) => Object.assign({ id, name: id, runType: "chute", widthM, path: line(x, 400) }, extra);

test("two parallel chutes closer than their half-widths overlap; far ones don't", () => {
  const r = GO.overlapping([C("a", 0, 40), C("b", 30, 40), C("far", 200, 40)]);
  assert.deepStrictEqual(r.map(x => x.id).sort(), ["a", "b"]);
  assert.strictEqual(r[0].neighbours[0].apartM, 30);
});

test("only chutes and runs are listed, never lifts or boot packs", () => {
  const r = GO.overlapping([C("a", 0, 40), C("lift", 10, 40, { runType: "lift" }), C("hike", 10, 40, { runType: "hike" })]);
  assert.strictEqual(r.length, 0);
});

test("the top 5% is ignored (shared entrances) but the bottom counts", () => {
  // b starts at a's top (touching for its first few metres) then splays 60 m away: not an overlap
  const a = C("a", 0, 10), b = C("b", 0, 10);
  b.path = b.path.map((p, i) => i === 0 ? p : [east(60), p[1]]);
  b.path[1] = [east(60), north(398)];   // splits off sideways right at the shared top
  assert.strictEqual(GO.overlapping([a, b]).length, 0, "touching only within the top 5% is not an overlap");
  // same lines but meeting at the BOTTOM: overlap
  const c = C("c", 0, 20), d = C("d", 60, 20);
  d.path[d.path.length - 1] = [east(0), north(0)];
  assert.strictEqual(GO.overlapping([c, d]).length, 2, "meeting at the bottom is an overlap");
});

test("closest first", () => {
  const r = GO.overlapping([C("a", 0, 40), C("b", 35, 40), C("c", 200, 40), C("d", 210, 40)]);
  assert.deepStrictEqual(r.map(x => x.id), ["c", "d", "a", "b"]);
});

// ---- the field through the Fence Editor's three zone mirrors, the panel, and Ridge Quest ----
const ed = fs.readFileSync(path.join(__dirname, "../frontend/fence-editor.html"), "utf8");
const rq = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");
test("guardDefaultOff survives Publish (zoneToEngine), reload (engineToZone) and Test Mode (editorToSimBundle)", () => {
  assert.ok(ed.includes("if(z.guardDefaultOff) zo.guardDefaultOff=true;"), "zoneToEngine exports it");
  assert.ok(ed.includes("z.guardDefaultOff=zo.guardDefaultOff===true;"), "engineToZone reads it back");
  assert.ok(ed.includes('guardDefaultOff:s.type==="corridor" && z.guardDefaultOff===true,'), "editorToSimBundle carries it");
});
test("the ⚙ button opens the list; toggling autosaves", () => {
  assert.ok(/<button id="pGuardDefaults"/.test(ed) && ed.includes('<script src="/guard-overlap.js"></script>'));
  assert.ok(/getElementById\("pGuardDefaults"\)\?\.addEventListener\("click", openGuardDefaults\)/.test(ed));
  assert.ok(/b\.onclick=\(\)=>\{ const z=byId\.get\(c\.id\); z\.guardDefaultOff=!z\.guardDefaultOff; paintName\(c\.id\); paintHead\(\); render\(\); \};/.test(ed),
    "tapping a name flips that run's field, repaints every row with it, and render() autosaves");
  assert.ok(/document\.body\.appendChild\(box\)/.test(ed), "panel on <body>, never inside #mainPanel");
  assert.ok(/GuardOverlap\.pairs\(/.test(ed) && /show\.onclick=\(\)=>_gdShowPair\(/.test(ed), "one row per conflict, each with 👁 Show");
  assert.ok(/const close=\(\)=>\{ _gdClearHighlight\(\); box\.remove\(\); \};/.test(ed), "closing removes the map highlight");
  assert.ok(ed.includes('id="stopsGuardDefaults"'), "also reachable from the stops toolbar");
});

test("pairs(): each conflict once, closest first", () => {
  const p = GO.pairs([C("a", 0, 40), C("b", 30, 40), C("c", 200, 40), C("d", 215, 40)]);
  assert.deepStrictEqual(p.map(x => [x.a.id, x.b.id].sort().join("+")), ["c+d", "a+b"]);
  assert.deepStrictEqual(p.map(x => x.apartM), [15, 30]);
  assert.strictEqual(p[0].a.widthM, 40);
});
test("Ridge Quest and Test Mode both read it", () => {
  assert.ok(rq.includes("this.defaultOffCorridors = new Set((bundle.zones||[]).filter(z=>z.guardDefaultOff===true).map(z=>z.id));"));
  assert.ok(ed.includes("filter(z=>z.guardDefaultOff===true)"), "Test Mode loads the same set");
});
