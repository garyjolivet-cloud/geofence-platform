// Ridge Quest: pan/zoom "lockout for a few seconds" (2026-09-23/24).
//
// Suspected cause: Battery Saver ("lift mode") flipped on/off as a run passed near a lift
// line, and each flip rebuilt 3D terrain and forced an easeTo(pitch 60) right under the
// rider's fingers. Fixes pinned here:
//   1. leaving lift mode needs a longer steady signal than entering it (hysteresis);
//   2. terrain pause/resume waits until no finger is down and the camera is idle;
//   3. resume restores the rider's own pitch instead of forcing 60.
//
// Run: `node --test tests/quest-lift-mode-terrain.test.js` (or the full suite).
"use strict";
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8").replace(/\r/g, "");

function extract(startTag) {
  const startIdx = html.indexOf(startTag);
  assert.ok(startIdx >= 0, "found " + startTag);
  let depth = 0, i = html.indexOf("{", startIdx);
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) break; }
  }
  return html.slice(startIdx, i + 1);
}

const enter = +html.match(/const LIFT_MODE_DEBOUNCE_MS = (\d+);/)[1];
const exit = +html.match(/const LIFT_MODE_EXIT_DEBOUNCE_MS = (\d+);/)[1];
const liftModeDebounceMs = new Function("LIFT_MODE_DEBOUNCE_MS", "LIFT_MODE_EXIT_DEBOUNCE_MS",
  extract("function liftModeDebounceMs(") + "; return liftModeDebounceMs;")(enter, exit);

test("leaving lift mode needs a longer steady signal than entering it", () => {
  assert.strictEqual(liftModeDebounceMs(false), enter);
  assert.strictEqual(liftModeDebounceMs(true), exit);
  assert.ok(exit >= 2 * enter, "exit " + exit + " should be at least twice enter " + enter);
});

test("auto mode only compares the raw reading against the current state", () => {
  assert.ok(html.includes("this._liftRaw !== this.liftModeActive && fix.t - this._liftRawSinceT >= liftModeDebounceMs(this.liftModeActive)"));
});

// whenMapCalm lives inside renderFogMap's closure; run the shipped source against fakes.
function makeCalm(state) {
  const src = extract("function whenMapCalm(fn){");
  const timers = [];
  const setT = (f, ms) => timers.push({ f, ms });
  const scope = {
    get mapPointersDown() { return state.down; },
    get lastMapTouchAt() { return state.last; },
    calmToken: 0, map: state.map, CALM_MS: 1500,
    Date: { now: () => state.now }, setTimeout: setT,
  };
  // sloppy-mode `with` lets the shipped closure's free variables resolve to the fakes
  const whenMapCalm = new Function("scope", "with(scope){ return (" + src + "); }")(scope);
  return { whenMapCalm, timers };
}

test("terrain change waits for fingers up, camera idle and 1.5 s of calm; newest request wins", () => {
  const state = { down: 1, last: 0, now: 10000, moving: false,
    map: { getContainer: () => ({ isConnected: true }), isMoving: () => state.moving } };
  const { whenMapCalm, timers } = makeCalm(state);
  const ran = [];
  whenMapCalm(() => ran.push("a"));
  assert.deepStrictEqual(ran, [], "finger down -> not yet");
  state.down = 0; state.last = 9500; timers.shift().f();
  assert.deepStrictEqual(ran, [], "touched 500 ms ago -> still waiting");
  state.now = 12000; state.moving = true; timers.shift().f();
  assert.deepStrictEqual(ran, [], "camera moving -> still waiting");
  state.moving = false; timers.shift().f();
  assert.deepStrictEqual(ran, ["a"], "calm -> runs");
  // newest wins
  state.down = 1;
  whenMapCalm(() => ran.push("old"));
  whenMapCalm(() => ran.push("new"));
  state.down = 0; state.now = 20000;
  timers.splice(0).forEach(t => t.f());
  assert.deepStrictEqual(ran, ["a", "new"], "superseded request never runs");
});

test("resume restores the rider's own pitch and pause is gated on calm", () => {
  assert.ok(html.includes("pitch:(opts && opts.pitch!=null) ? opts.pitch : 60"));
  assert.ok(html.includes("setTerrainOn(userWantsTerrain, { pitch: pitchBeforeBatteryPause })"));
  const handler = extract("Quest.onLiftModeChange = (active)=>{");
  assert.ok(/whenMapCalm\(\(\)=>\{[\s\S]*setTerrainOn\(false\)/.test(handler), "pause inside whenMapCalm");
  assert.ok(!/^\s*setTerrainOn\(/m.test(handler.replace(/whenMapCalm\(\(\)=>\{[\s\S]*?\n        \}\);/g, "")), "no ungated setTerrainOn in the handler");
});
