// Guards the new Ridge Quest "elevation checkpoint" per-zone fields
// (isElevCheckpoint / checkpointElevM) against a future edit dropping them
// from one of the wiring sites. Modelled on the viewpoint field flow
// (isViewpoint / viewshedCells), which CLAUDE.md's "verbatim mirror" rule
// requires to appear in the property panel populate/write, zoneToEngine
// (publish), engineToZone (reload) AND editorToSimBundle (Test Mode).
//
// Source-regex checks only (same approach as
// tests/fence-editor-corridor-mirror.test.js's mirror assertions) — no
// runtime scaffold needed.
//
// Run: `node tests/fence-editor-checkpoint-mirror.test.js`
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const html = fs.readFileSync(path.join(__dirname, "../frontend/fence-editor.html"), "utf8");

function extractMethodBody(startTag) {
  const startIdx = html.indexOf(startTag);
  if (startIdx < 0) throw new Error("could not find " + startTag + " in fence-editor.html");
  let depth = 0, i = html.indexOf("{", startIdx);
  const bodyStart = i + 1;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) break; }
  }
  return html.slice(bodyStart, i);
}

(function testPanelHtmlPresent() {
  assert(/id="pElevCheckpointSection"/.test(html), "panel has an #pElevCheckpointSection");
  assert(/id="pIsElevCheckpoint"/.test(html) && /id="pCheckpointElevM"/.test(html) && /id="pCheckpointUseTerrain"/.test(html),
    "panel has the checkbox, elevation input, and DEM-fill button");
})();

(function testRefreshPropsPopulates() {
  const body = extractMethodBody("function refreshProps(");
  assert(/pElevCheckpointSection"\)\.style\.display\s*=\s*isCircle/.test(body.replace(/\s+/g, "")) ||
         /getElementById\("pElevCheckpointSection"\)\.style\.display=isCircle/.test(body.replace(/\s+/g, "")),
    "refreshProps toggles the checkpoint section on isCircle");
  assert(/pIsElevCheckpoint"\)\.checked=!!z\.isElevCheckpoint/.test(body.replace(/\s+/g, "")),
    "refreshProps populates the checkbox from z.isElevCheckpoint");
  assert(/pCheckpointElevM"\)\.value=z\.checkpointElevM/.test(body.replace(/\s+/g, "")),
    "refreshProps populates the elevation input from z.checkpointElevM");
})();

(function testBindPropWriters() {
  assert(/bindProp\("pIsElevCheckpoint",\s*z=>\{[\s\S]{0,200}z\.isElevCheckpoint\s*=/.test(html),
    "bindProp('pIsElevCheckpoint') writes z.isElevCheckpoint");
  assert(/bindProp\("pCheckpointElevM",\s*z=>\{[\s\S]{0,200}z\.checkpointElevM\s*=/.test(html),
    "bindProp('pCheckpointElevM') writes z.checkpointElevM");
  // The DEM-fill button is a verbatim clone of #pAltUseTerrain, writing
  // z.checkpointElevM instead of z.altM.
  assert(/getElementById\("pCheckpointUseTerrain"\)\.onclick[\s\S]{0,900}z\.checkpointElevM\s*=\s*Math\.round\(elevM\)/.test(html) &&
         /getElementById\("pCheckpointUseTerrain"\)\.onclick[\s\S]{0,900}map\.queryTerrainElevation/.test(html),
    "#pCheckpointUseTerrain stamps z.checkpointElevM from map.queryTerrainElevation");
})();

(function testZoneToEngineEmits() {
  const body = extractMethodBody("function zoneToEngine(z){").replace(/\s+/g, " ");
  assert(/s\.type==="circle" && z\.isElevCheckpoint/.test(body) &&
         /zo\.isElevCheckpoint=true/.test(body) && /zo\.checkpointElevM=/.test(body),
    "zoneToEngine emits zo.isElevCheckpoint + zo.checkpointElevM for a circle checkpoint");
})();

(function testEngineToZoneRestores() {
  const body = extractMethodBody("function engineToZone(zo){").replace(/\s+/g, " ");
  assert(/shape\.type==="circle" && zo\.isElevCheckpoint/.test(body) &&
         /z\.isElevCheckpoint=true/.test(body) && /z\.checkpointElevM=/.test(body),
    "engineToZone restores z.isElevCheckpoint + z.checkpointElevM from the bundle");
})();

(function testEditorToSimBundleCarries() {
  const body = extractMethodBody("function editorToSimBundle(){").replace(/\s+/g, " ");
  assert(/isElevCheckpoint:\(?s\.type==="circle"/.test(body) && /checkpointElevM:/.test(body),
    "editorToSimBundle carries isElevCheckpoint + checkpointElevM into the Test Mode snapshot");
})();

(function testMakeZoneDoesNotDefault() {
  const body = extractMethodBody("function makeZone(name,shape){");
  assert(!/isElevCheckpoint/.test(body) && !/checkpointElevM/.test(body),
    "makeZone does NOT default the checkpoint fields (lazy-created, exactly like isViewpoint)");
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
