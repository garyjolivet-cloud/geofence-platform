// GPX Editor Save As must not create library duplicates (2026-09-30): Darwin 2 was in the
// corridor library twice, identical, saved 19 s apart -- Save As keeping the open corridor's
// own name skipped the name match and POSTed a second row. Runs the real saveAsNamed().
//
// Run: `node tests/gpx-editor-save-as.test.js`
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const html = fs.readFileSync(path.join(__dirname, "../frontend/gpx-editor.html"), "utf8");
function extract(startTag) {
  const s = html.indexOf(startTag);
  if (s < 0) throw new Error("could not find " + startTag);
  let depth = 0, i = html.indexOf("{", s);
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) break; }
  }
  return html.slice(s, i + 1);
}
const SRC = extract("async function saveAsNamed(name){");

function rig(loadedFrom, allCorridors, confirmAnswer) {
  const calls = [];
  const env = {
    appId: "kh", points: [[-117, 51, 2000], [-117.001, 51.001, 1990]], allCorridors, confirmAnswer,
    ensureElevationBeforeSave: async () => {}, runDetailsPayload: () => ({ runType: "chute" }),
    currentTotals: () => ({ distanceM: 100, elevGainM: 0, elevLossM: 10 }),
    patchJson: async (url, body) => { calls.push(["PATCH", url]); return {}; },
    postJson: async (url, body) => { calls.push(["POST", body.name]); return { id: "new-" + calls.length }; },
    gpxTree: { getUploadTarget: () => null, setActive() {}, refresh() {} },
    updateHdrCrumb() {}, captureBaseline() {}, loadAllCorridors() {},
    confirm: () => confirmAnswer, alert: m => { throw new Error("alert: " + m); },
    overlapWarning: () => "",   // 2026-10-04 overlap warning after a save; none in these cases
    document: { getElementById: () => ({}) }
  };
  const keys = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...keys, "let loadedFrom = arguments[arguments.length-1];\n" + SRC + "\nreturn { saveAsNamed, get loadedFrom(){ return loadedFrom; } };")(...keys.map(k => env[k]), loadedFrom);
  return { fn, calls };
}

(async function () {
  {
    const { fn, calls } = rig({ kind: "corridor", id: "d2", name: "Darwin 2" }, [{ id: "d2", name: "Darwin 2" }]);
    await fn.saveAsNamed("Darwin 2");
    assert(calls.length === 1 && calls[0][0] === "PATCH" && calls[0][1] === "/api/corridor/d2", "Save As with the open corridor's own name saves over it, got " + JSON.stringify(calls));
  }
  {
    const { fn, calls } = rig({ kind: "corridor", id: "d2", name: "Darwin 2" }, [{ id: "d2", name: "Darwin 2" }]);
    await fn.saveAsNamed("darwin 2");   // the click handler trims the prompt answer
    assert(calls[0][0] === "PATCH", "name match ignores case");
  }
  {
    const { fn, calls } = rig({ kind: "corridor", id: "ei", name: "Easy In" }, [{ id: "ei", name: "Easy In" }]);
    await fn.saveAsNamed("Pine Tree");
    assert(calls.length === 1 && calls[0][0] === "POST" && fn.loadedFrom.name === "Pine Tree", "a new name still makes a new corridor");
    await fn.saveAsNamed("Pine Tree");
    assert(calls.length === 2 && calls[1][0] === "PATCH", "Save As again with that name saves over the new row, not a third");
  }
  {
    const { fn, calls } = rig({ kind: "corridor", id: "a", name: "A" }, [{ id: "a", name: "A" }, { id: "b", name: "B" }], false);
    await fn.saveAsNamed("B");
    assert(calls.length === 0, "naming it after another corridor asks first; Cancel writes nothing");
  }
  const handler = extract('document.getElementById("saveAsBtn").onclick=async()=>');
  assert(/if\(_saveAsBusy\) return;/.test(handler) && /finally \{ _saveAsBusy=false; \}/.test(handler), "a second Save As can't start while one is saving");

  console.log(pass + " passed, " + fail + " failed");
  if (fail > 0) process.exit(1);
})();
