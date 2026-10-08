// Eyes up (2026-10-08, Gary: "Screen need to go black when mobile is not stationary. A warning screen can be
// displayed telling danger of looking at screen while moving").
// While the rider is skiing the phone's screen is black at once; a touch shows a warning instead of waking it;
// stopping brings it back. Not on a lift, not off the run network, never stuck black when GPS is lost.
// The REAL SLEEP_TUNING / movingStep / sleepDecision / ScreenSleep are cut out of ridge-quest.html and run
// against a fake page.
//
// Run: `node --test tests/quest-eyes-up.test.js` (or the full suite).
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const test = require("node:test");
const assert = require("node:assert");

const rq = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8").replace(/\r/g, "");
const grab = re => { const m = rq.match(re); assert.ok(m, "found " + re); return m[0]; };
const fn = tag => { const s = rq.indexOf(tag); assert.ok(s >= 0, tag); let d = 0, i = rq.indexOf("{", s); for (; i < rq.length; i++) { if (rq[i] === "{") d++; else if (rq[i] === "}") { d--; if (d === 0) break; } } return rq.slice(s, i + 1); };
const SRC = [grab(/const SLEEP_TUNING = \{[\s\S]*?\n\};/), fn("function stationaryStep(anchor, fix, distFn){"), fn("function movingStep(m, s){"),
  fn("function sleepDecision(s){"), grab(/const ScreenSleep = \{[\s\S]*?\n\};/)].join("\n");

function page() {
  let now = 1760000000000;
  const timers = []; let el = null;
  const node = () => ({ style: {}, attrs: {}, innerHTML: "", onclick: null, setAttribute(k, v) { this.attrs[k] = v; } });
  const sb = {
    Date: { now: () => now }, isFinite, Math,
    document: { createElement: () => (el = node()), body: { appendChild() {} }, addEventListener() {}, removeEventListener() {} },
    setInterval: () => 1, clearInterval() {},
    setTimeout: (f, ms) => { timers.push({ f, at: now + ms }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].f = null; },
    Quest: { active: () => true, liftModeActive: false, liftModeOverride: "auto", _liftRaw: false, _offsite: false },
    QGeo: { haversineM: () => 0 }, lock: { acquired: 0, released: 0 }
  };
  sb.acquireWakeLock = () => sb.lock.acquired++; sb.releaseWakeLock = () => sb.lock.released++;
  vm.createContext(sb);
  vm.runInContext(SRC + "\nthis.ScreenSleep = ScreenSleep; this.SLEEP_TUNING = SLEEP_TUNING; this.movingStep = movingStep; this.sleepDecision = sleepDecision;", sb);
  const S = sb.ScreenSleep; S.start();
  const api = {
    S, sb, T: sb.SLEEP_TUNING,
    // one GPS fix a second at `speed` m/s for `secs` seconds
    go(speed, secs, acc) { for (let i = 0; i < secs; i++) { now += 1000; S.noteSpeed(speed, { acc: acc == null ? 8 : acc, t: now }); } },
    wait(ms) { now += ms; timers.forEach(t => { if (t.f && t.at <= now) { const f = t.f; t.f = null; f(); } }); S._tick(); },
    tap() { el.onclick({ preventDefault() {}, stopPropagation() {} }); },
    get black() { return S.dimmed && el.style.display === "flex"; },
    get says() { return el ? el.innerHTML.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : ""; },
    get label() { return el ? el.attrs["aria-label"] : ""; }
  };
  return api;
}

test("skiing blacks the screen within three fixes; standing or walking does not", () => {
  const p = page();
  p.go(0.3, 5); assert.ok(!p.S.dimmed, "standing: screen on");
  p.go(1.4, 10); assert.ok(!p.S.dimmed, "walking to the lift: screen on");
  p.go(8, 1); assert.ok(!p.S.dimmed, "one fast reading is not enough");
  p.go(8, 2); assert.ok(p.black, "skiing for 2 s: black");
  assert.strictEqual(p.says, "MOVING · SCREEN OFF · STILL TRACKING");
  assert.match(p.label, /Screen off while you are moving/);
});

test("a touch while moving shows the danger warning, not the app; it goes back to black", () => {
  const p = page();
  p.go(8, 4); assert.ok(p.black);
  p.tap();
  assert.ok(p.black, "still black behind the warning");
  assert.match(p.says, /EYES UP/);
  assert.match(p.says, /Looking at your phone while you are moving is dangerous\./);
  assert.match(p.says, /Stop somewhere safe and the screen comes back\. Tracking, the guard tone and the voice are still on\./);
  assert.match(p.label, /^Warning: looking at your phone while moving is dangerous/);
  p.go(8, 3); assert.match(p.says, /EYES UP/, "stays up while the timer runs");
  p.wait(p.T.MOVE_WARN_MS);
  assert.strictEqual(p.says, "MOVING · SCREEN OFF · STILL TRACKING", "then back to plain black");
  assert.ok(p.black);
});

test("stopping brings the screen back -- at once if the rider touched it, else on a tap", () => {
  let p = page();
  p.go(8, 4); p.tap();                       // asked for the screen while moving
  p.go(0.2, 3); assert.ok(p.black, "a 3 s pause mid-turn keeps it black");
  p.go(0.2, 2); assert.ok(!p.S.dimmed, "stopped for 4 s: the screen is back");
  p = page();
  p.go(8, 4); p.wait(40000 - 4000); p.go(8, 1);   // 40 s of skiing with the phone in a pocket
  p.go(0.2, 5);
  assert.ok(p.black, "untouched for 30 s: it stays dimmed like any idle screen");
  assert.strictEqual(p.says, "TAP TO WAKE · STILL TRACKING");
  p.tap(); assert.ok(!p.S.dimmed, "a tap wakes it once stopped");
});

test("not on a lift, not off the run network, and never stuck black when GPS is lost", () => {
  let p = page();
  p.sb.Quest._liftRaw = true; p.go(5, 10);
  assert.ok(!p.S.dimmed, "riding a lift: the map stays readable");
  p.sb.Quest._liftRaw = false; p.go(8, 1);
  assert.ok(p.black, "off the lift and skiing: black");
  p = page(); p.sb.Quest._offsite = true; p.go(20, 10);
  assert.ok(!p.S.dimmed, "off the run network (the road in): not blacked");
  p = page(); p.go(8, 4); assert.ok(p.black);
  p.wait(p.T.MOVE_STALE_MS + 1000);
  assert.ok(p.S.dimmed === false || p.says === "TAP TO WAKE · STILL TRACKING", "no fix for 10 s: no longer treated as moving");
  assert.ok(!p.S.isMoving(), "speed unknown = not moving");
  p = page(); p.go(8, 10, 90);
  assert.ok(!p.S.dimmed, "a fix with 90 m accuracy can't start it (indoor GPS makes up speed)");
});

test("it is a safety blackout: Battery Saver 'Always Off' does not switch it off, and the wake lock is kept", () => {
  const p = page();
  p.sb.Quest.liftModeOverride = "off";
  p.go(8, 4);
  assert.ok(p.black, "black while skiing even with Battery Saver Always Off");
  p.wait(30 * 60000 - 5000); p.go(8, 3);
  assert.strictEqual(p.sb.lock.released, 0, "the wake lock is never released while moving (tracking would stop)");
  assert.strictEqual(p.sb.sleepDecision({ moving: true, saverOff: true, now: 0, lastTouchAt: 0, stationaryForMs: 9e9, liftModeActive: false }), "moving");
});

test("movingStep: hysteresis both ways, and an unknown speed changes nothing", () => {
  const p = page(), step = p.sb.movingStep, T = p.T;
  assert.deepStrictEqual([T.MOVE_ON_MPS, T.MOVE_ON_MS, T.MOVE_OFF_MPS, T.MOVE_OFF_MS, T.MOVE_STALE_MS], [2.5, 2000, 1.0, 4000, 10000]);
  let m = step(null, { speedMps: 3, acc: 8, t: 0 }); assert.deepStrictEqual({ ...m }, { moving: false, since: 0 });
  m = step(m, { speedMps: null, acc: 8, t: 500 }); assert.deepStrictEqual({ ...m }, { moving: false, since: 0 }, "unknown speed: unchanged");
  m = step(m, { speedMps: 1.5, acc: 8, t: 1000 }); assert.deepStrictEqual({ ...m }, { moving: false, since: null }, "slowed again: the count restarts");
  m = step(m, { speedMps: 3, acc: 8, t: 2000 }); m = step(m, { speedMps: 3, acc: 8, t: 4000 });
  assert.strictEqual(m.moving, true);
  m = step(m, { speedMps: 0.5, acc: 8, t: 5000 }); m = step(m, { speedMps: 1.2, acc: 8, t: 6000 });
  assert.deepStrictEqual({ ...m }, { moving: true, since: null }, "a slow walk between 1.0 and 2.5 keeps whatever state it was in");
  m = step(m, { speedMps: 0, acc: 8, t: 7000 }); m = step(m, { speedMps: 0, acc: 8, t: 11000 });
  assert.strictEqual(m.moving, false);
});

test("wired into every fix without being able to break tracking; explained to the rider", () => {
  const onFix = fn("_onFix(pos){");
  assert.ok(onFix.includes("try{ ScreenSleep.noteSpeed((c.speed!=null && isFinite(c.speed)) ? c.speed : p.speed, fix); }catch(e){}"), "fed the phone's own speed, else the filter's, inside try/catch");
  assert.ok(onFix.indexOf("ScreenSleep.noteSpeed(") < onFix.indexOf("if(Quest._offsite){"), "before the off-site return, like noteFix");
  assert.ok(rq.includes("row('⚠ Eyes up','While you are skiing the screen is black"), "My map's ⓘ panel explains it");
  const help = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest-help.html"), "utf8");
  assert.ok(/Eyes up — the screen is black while you ski\./.test(help) && /looking at your phone while moving is dangerous/.test(help), "the help page explains it");
  const shown = fn("_paint(mode){");
  assert.ok(!/km\/h|mph|speed/i.test(shown), "the warning never shows a speed");
});
