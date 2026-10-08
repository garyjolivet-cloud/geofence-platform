// Fence Editor Test Mode is read-only for stops (2026-10-08, Gary: "in test mode stops of all
// types are read only. no moving or updating parameters of stops").
// The side panel (properties, stop list, shape picker) was already hidden in Test Mode, but the
// map still moved stops, showed drag handles and opened the rename/copy/delete menu, and the
// palettes / library pull could still change them. Every one of those paths asks stopsLocked().
// The pull itself is run for real in tests/fence-editor-corridor-sync.test.js.
//
// Run: `node --test tests/fence-editor-test-mode-readonly.test.js` (or the full suite).
"use strict";
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const html = fs.readFileSync(path.join(__dirname, "../frontend/fence-editor.html"), "utf8").replace(/\r/g, "");
function extract(startTag) {
  const s = html.indexOf(startTag);
  assert.ok(s >= 0, "found " + startTag);
  let depth = 0, i = html.indexOf("{", s);
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) break; }
  }
  return html.slice(s, i + 1);
}

test("stopsLocked: off while editing, on in Test Mode, and it says why at most once per 3 s", () => {
  const toasts = [];
  let now = 100000;
  // eslint-disable-next-line no-new-func
  const api = new Function("toast", "Date",
    "let simMode=false, _stopsLockToldAt=0;\n" + extract("function stopsLocked(tell){") +
    "\nreturn { stopsLocked, set simMode(v){ simMode=v; } };")(m => toasts.push(m), { now: () => now });
  assert.strictEqual(api.stopsLocked(true), false, "editing: not locked");
  assert.strictEqual(toasts.length, 0);
  api.simMode = true;
  assert.strictEqual(api.stopsLocked(), true, "Test Mode: locked");
  assert.strictEqual(toasts.length, 0, "silent unless asked to tell");
  api.stopsLocked(true); api.stopsLocked(true);
  assert.strictEqual(toasts.length, 1, "one toast, not one per blocked gesture");
  assert.match(toasts[0], /read-only/);
  now += 3500; api.stopsLocked(true);
  assert.strictEqual(toasts.length, 2);
});

test("selecting a stop does nothing in Test Mode; deselecting still works", () => {
  const calls = [];
  // eslint-disable-next-line no-new-func
  const api = new Function("renderSources", "applySelRowHighlight", "refreshHandles", "clearHandles", "refreshProps", "stopsLocked",
    "let sel=-1; const zones=[{id:'a'},{id:'b'}];\n" + extract("function selectZone(i){") +
    "\nreturn { selectZone, get sel(){ return sel; }, set sel(v){ sel=v; } };");
  let locked = true;
  const a = api(() => calls.push("render"), () => {}, () => calls.push("handles"), () => calls.push("clear"), () => {}, () => locked);
  a.selectZone(1);
  assert.strictEqual(a.sel, -1, "not selected");
  assert.strictEqual(calls.length, 0, "no redraw, no handles");
  a.sel = 1; a.selectZone(-1);
  assert.strictEqual(a.sel, -1, "deselect (enterTestMode) still goes through");
  locked = false; a.selectZone(0);
  assert.strictEqual(a.sel, 0, "editing: selects as before");
  assert.ok(calls.includes("handles"));
});

test("every way to change a stop from outside the hidden panel asks stopsLocked first", () => {
  const first = (fn, re, why) => {
    const src = extract(fn);
    const at = src.search(/stopsLocked\(/);
    assert.ok(at >= 0, fn + " asks stopsLocked");
    const m = src.search(re);
    assert.ok(m >= 0 && at < m, why);
  };
  first("function _zoneMousedown(e){", /_zoneDrag=\{/, "no drag starts on a stop");
  first("function refreshHandles(z){", /new maplibregl\.Marker/, "no drag handles are built");
  first("function openZoneMenu(anchorBtn,zoneId){", /openPortalMenu\(/, "no rename / copy / move / delete menu");
  first("function attachArObjectToZone(zoneIdx,asset){", /z\.arObjects\.push/, "no AR object attached");
  first("function openGuardDefaults(){", /createElement/, "no Guard defaults panel (it sets zone.guardDefaultOff)");
  first("async function importCorridorFromLibrary(corridorId){", /zones\.findIndex/, "no corridor added or selected");
  first("async function reconcileLinkedCorridors(){", /_corrReconcileBusy=true/, "no library pull");
  first("function _makeZoneRowDroppable(rowEl, zoneIdx){", /CodeObjects\.attach/, "no drop on a stop row");

  // Map drops: a code object or audio clip dropped near a stop.
  const drop = html.slice(html.indexOf("function setupMapDrop(){"), html.indexOf("/* ---- zone list rows drop target"));
  const co = drop.indexOf("CodeObjects.attach(zones[best]");
  assert.ok(drop.lastIndexOf("stopsLocked(true)", co) > drop.indexOf('getData("codeobjectid")'), "code object drop on a stop is refused");
  const au = drop.indexOf("zones[best][zoneAudioField(zones[best])]=audioUrl");
  assert.ok(drop.lastIndexOf("stopsLocked(true)", au) > drop.indexOf('getData("audiourl")'), "audio clip drop on a stop is refused");
  // A global Code Object (empty map, not a stop) is NOT a stop parameter and still works in Test Mode.
  assert.ok(/else if\(CodeObjects\.attach\(\{codeObjects:globalCodeObjects\}/.test(drop), "global code object drop is left alone");

  assert.ok(/getTargets:\(\)=>\{\s*if\(stopsLocked\(\)\) return \[\];/.test(html), "Code Objects palette clicks have no target stop");
  assert.ok(/getElementById\("gpxPullShapes"\)\.onclick=\(\)=>\{ if\(stopsLocked\(true\)\) return;/.test(html), "the ⟳ shapes button says read-only");
});

test("entering Test Mode shuts the Guard defaults panel and any open stop menu; Exit test runs a held pull", () => {
  const enter = extract("function enterTestMode(){");
  assert.ok(enter.indexOf("simMode=true") < enter.indexOf('getElementById("guardDefaultsOverlay")?.remove()'), "panel closed on entry");
  assert.ok(enter.includes("closeStopFolderMenus()"), "open ⋯ menu closed on entry");
  const exit = extract("function exitTestMode(){");
  assert.ok(exit.indexOf("simMode=false") < exit.indexOf("if(_corrReconcilePending){ _corrReconcilePending=false; reconcileLinkedCorridors(); }"),
    "the held library pull runs once stops are editable again");
});
