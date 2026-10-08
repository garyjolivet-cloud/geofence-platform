// My map info panel (2026-10-06): an ⓘ button on My map opens a panel over the map explaining each
// button and how to get runs and chutes logged. The rules it states must match the real ones.
// Run: `node --test tests/quest-map-info.test.js` (or the full suite).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
// QUEST_TUNING moved to quest-core.js on 2026-10-08; both are read as one source.
const rq = (fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8") + fs.readFileSync(path.join(__dirname, "../frontend/quest-core.js"), "utf8")).replace(/\r/g, "");
const info = rq.slice(rq.indexOf("function openMapInfo(){"), rq.indexOf("function renderFogMap(){"));

test("My map has an info button that opens the panel over the map (no page change)", () => {
  const fm = rq.slice(rq.indexOf("function renderFogMap(){"), rq.indexOf("function renderFogMap(){") + 6000);
  assert.ok(/id="fogInfo"/.test(fm) && /getElementById\("fogInfo"\)\.onclick=\(\)=>openMapInfo\(\);/.test(fm));
  assert.ok(/document\.querySelector\("\.fogMapOverlay"\)/.test(info) && /host\.appendChild\(el\)/.test(info), "added inside the map screen");
  assert.ok(!/renderHome|location\.href|app\.innerHTML/.test(info), "never leaves the map (tracking keeps running)");
});

test("every map button is explained", () => {
  ["← Back", "3D", "⌖", "🔋 Auto", "🛡 Guard", "Skied", "Lines", "Season", "Tap a run", "Hold 2 s"].forEach(k =>
    assert.ok(info.includes("row('" + k + "'"), k));
});

test("the logging strategy states the real rules", () => {
  assert.ok(/CORRIDOR_COMPLETION_PCT: 0\.8,/.test(rq) && /about 80% of it going down/.test(info), "80% coverage");
  assert.ok(/holdMs: 2000,/.test(rq) && /Hold 2 s/.test(info), "2 s hold");
  assert.ok(/ARMED_ADJ_PAD_M: 10/.test(rq) && /within about 10 m of an armed one are ignored/.test(info), "armed isolation 10 m");
  assert.ok(/STATIONARY_LOCK_MS: 10\*60000,/.test(rq) && /sits still for 10 minutes/.test(info), "lunch lock");
  assert.ok(!/speed|fast|turns/i.test(info.replace(/fastest/g, "")), "never about speed or turns");
});

// 2026-10-06, Gary: "where is home that shows no signal runs. i cant see it anywhere" — the note
// was hidden whenever nothing was waiting. It now always shows on Home.
test("Home always shows the outbox line: waiting runs, or all sent", () => {
  const f = rq.slice(rq.indexOf("function paintOutboxNote(){"), rq.indexOf("/* ===================== OFFLINE OUTBOX"));
  assert.ok(/if\(!items\.length\)\{ el\.textContent = "✓ All runs sent"; el\.style\.display=""; return; \}/.test(f));
  assert.ok(/saved on your phone — will send when you have signal/.test(f));
  assert.ok(/✓ All runs sent/.test(info), "the map tip names both states");
});
