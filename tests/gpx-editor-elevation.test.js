// GPX Editor automatic elevation (frontend/gpx-editor.html, 2026-09-29): points added to
// the start/end of a corridor (and hand-drawn corridors) had no elevation, so a chute's
// descent came out short, or 0. Added points now get terrain elevation at once, and
// Save / Save As fill any point still missing one before the totals are computed.
// Runs the real functions extracted from the shipped file against a fake DEM tile.
//
// Run: `node tests/gpx-editor-elevation.test.js`
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

(async function () {
  // ---- demElevation: Terrarium decode (elev = R*256 + G + B/256 - 32768) on a fake tile ----
  const W = 256, data = new Uint8ClampedArray(W * W * 4);
  const elevAt = 2142.5; // encode everywhere
  const v = elevAt + 32768;
  for (let i = 0; i < W * W; i++) { data[i * 4] = Math.floor(v / 256); data[i * 4 + 1] = Math.floor(v) % 256; data[i * 4 + 2] = Math.round((v % 1) * 256); data[i * 4 + 3] = 255; }
  let asked = null;
  // eslint-disable-next-line no-new-func
  const demElevation = new Function("_demTile", "DEM_Z", "return (" + extract("async function demElevation(").replace(/^async function demElevation/, "async function") + ")")(
    async (x, y) => { asked = [x, y]; return { w: W, data }; }, 15);
  const e = await demElevation(-117.0724, 51.28135);
  assert(e === Math.round(elevAt), "decodes Terrarium RGB to metres, got " + e);
  // Web-Mercator tile for that point at z15 (independently computed)
  const n = 2 ** 15, r = 51.28135 * Math.PI / 180;
  assert(asked && asked[0] === Math.floor((-117.0724 + 180) / 360 * n) &&
    asked[1] === Math.floor((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2 * n), "asks for the right z15 tile");
  // eslint-disable-next-line no-new-func
  const demFails = new Function("_demTile", "DEM_Z", "return (" + extract("async function demElevation(").replace(/^async function demElevation/, "async function") + ")")(
    async () => { throw new Error("offline"); }, 15);
  assert((await demFails(-117, 51)) === null, "an unreadable tile gives null, never throws");

  // ---- fillMissingElevation: fills only missing points, in place ----
  const fillSrc = extract("async function fillMissingElevation(").replace(/^async function fillMissingElevation/, "async function");
  function rig(base, dem) {
    const scope = { basePoints: base, refreshed: 0 };
    // eslint-disable-next-line no-new-func
    const fn = new Function("scope", "demElevation", "refreshActive",
      "return (" + fillSrc.replace(/basePoints/g, "scope.basePoints") + ")")(scope, dem, () => { scope.refreshed++; });
    return { scope, fn };
  }
  {
    const base = [[-117, 51.29, null, null], [-117, 51.28, 2100, null], [-117, 51.27, 2050, null], [-117, 51.26, null, null]];
    const keep1 = base[1], keep2 = base[2];
    const { scope, fn } = rig(base, async (lon, lat) => Math.round(2000 + (lat - 51.26) * 5000));
    const res = await fn();
    assert(res.missing === 2 && res.filled === 2, "two missing points filled");
    assert(base[0][2] === 2150 && base[3][2] === 2000, "added start and end got terrain elevation");
    assert(keep1[2] === 2100 && keep2[2] === 2050, "points that had elevation are never changed");
    assert(scope.refreshed === 1, "the chart/totals are refreshed");
  }
  {
    const base = [[-117, 51.29, null], [-117, 51.28, 2100], [-117, 51.27, null]];
    const { fn } = rig(base, async () => null);
    const res = await fn();
    assert(res.missing === 2 && res.filled === 0, "reports when the terrain can't be read");
    assert(base[0][2] === 2100 && base[2][2] === 2100, "unreadable points hold the nearest known elevation");
  }
  {
    const base = [[-117, 51.29, 2100], [-117, 51.28, 2090]];
    let calls = 0;
    const { scope, fn } = rig(base, async () => { calls++; return 1; });
    const res = await fn();
    assert(res.missing === 0 && calls === 0 && scope.refreshed === 0, "nothing to do when every point has elevation");
  }

  // ---- wiring ----
  const clickSrc = html.slice(html.indexOf('if(!addMode) return; // "end" mode'), html.indexOf("/* ---- draw a brand-new corridor"));
  assert(/demElevation\(pt\[0\],pt\[1\]\)/.test(clickSrc), "a point added in add mode looks up its terrain elevation");
  const save = extract('document.getElementById("saveBtn").onclick=async()=>');
  assert(save.indexOf("await ensureElevationBeforeSave()") > -1 && save.indexOf("await ensureElevationBeforeSave()") < save.indexOf("currentTotals()"),
    "Save fills missing elevation before computing the totals");
  const saveAs = extract('document.getElementById("saveAsBtn").onclick=async()=>');
  assert(saveAs.indexOf("await ensureElevationBeforeSave()") > -1 && saveAs.indexOf("await ensureElevationBeforeSave()") < saveAs.indexOf("currentTotals()"),
    "Save As fills missing elevation before computing the totals");

  console.log(pass + " passed, " + fail + " failed");
  if (fail > 0) process.exit(1);
})();
