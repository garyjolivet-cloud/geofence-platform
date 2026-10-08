// Fence Editor "🗣 This is…" button (2026-10-02): every stop's spoken line becomes
// "This is " + the stop's name. The helpers are extracted from the shipped file.
//
// Run: `node --test tests/fence-editor-say-this-is.test.js` (or the full suite).
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

const html = fs.readFileSync(path.join(__dirname, "../frontend/fence-editor.html"), "utf8");
function extractFunction(startTag) {
  const s = html.indexOf(startTag);
  if (s < 0) { console.log("FAIL: could not find " + startTag); process.exit(1); }
  let d = 0, i = html.indexOf("{", s);
  for (; i < html.length; i++) { if (html[i] === "{") d++; else if (html[i] === "}") { d--; if (d === 0) break; } }
  return html.slice(s, i + 1);
}
// eslint-disable-next-line no-new-func
const setAll = new Function(extractFunction("function thisIsLine(z){") + "\n" +
  extractFunction("function setAllStopLinesThisIs(list){") + "\nreturn setAllStopLinesThisIs;")();

(function testSetsEveryStop() {
  const zs = [
    { name: "Big Dumper", say: "This is Main dump chute" },
    { name: "Bat Man", say: "A sporty entry" },
    { name: "Golden Eagle Express Gondi" },
    { name: "  Pine Tree  ", say: "" }
  ];
  const n = setAll(zs);
  assert(n === 4, "all four stops changed, got " + n);
  assert(zs.map(z => z.say).join("|") === "This is Big Dumper|This is Bat Man|This is Golden Eagle Express Gondi|This is Pine Tree",
    "each line is \"This is \" + the trimmed name, got " + zs.map(z => z.say).join("|"));
})();

(function testAlreadyRightAndNamelessAreLeftAlone() {
  const zs = [{ name: "Heli Pad", say: "This is Heli Pad" }, { name: "", say: "keep me" }, { say: "keep me too" }];
  assert(setAll(zs) === 0, "nothing to change => 0");
  assert(zs[1].say === "keep me" && zs[2].say === "keep me too", "a stop with no name keeps its line");
})();

(function testButtonWiring() {
  assert(/<button id="sayThisIsAll"/.test(html), "the 🗣 button is in the stop list toolbar");
  const h = html.slice(html.indexOf('document.getElementById("sayThisIsAll").onclick'));
  const body = h.slice(0, h.indexOf("\n};") + 3);
  assert(/confirm\(/.test(body) && body.indexOf("confirm(") < body.indexOf("setAllStopLinesThisIs(zones)"),
    "asks before overwriting (and says how many custom lines are replaced)");
  assert(/render\(\);/.test(body), "render() autosaves the draft; Publish sends it");
})();

// 2026-10-07: "i renamed crystal bowl right and it still uses old name in test even after publishing"
(function testRenameCarriesTheAutomaticLine() {
  // eslint-disable-next-line no-new-func
  const setStopName = new Function(extractFunction("function thisIsLine(z){") + "\n" +
    extractFunction("function setStopName(z, name){") + "\nreturn setStopName;")();
  let z = { name: "Right Crysal Right", say: "This is Right Crysal Right" };
  setStopName(z, "Crystal Bowl right");
  assert(z.name === "Crystal Bowl right" && z.say === "This is Crystal Bowl right", "the automatic line follows a rename, got " + z.say);
  z = { name: "PW", say: "This is Peee Double U" };
  setStopName(z, "P W");
  assert(z.say === "This is Peee Double U", "a line the author wrote is left alone");
  z = { name: "Bat Man" };
  setStopName(z, "Batman");
  assert(z.say === undefined, "a stop with no line gets none");
  z = { name: "Bat Man", say: "This is Bat Man" };
  setStopName(z, "");
  assert(z.say === "This is Bat Man", "clearing the name keeps the line");
  assert(!/[^.\w]z\.name\s*=\s*(row\.name|j\.name|document)/.test(html) && (html.match(/setStopName\(z, /g) || []).length === 5,   // 4 calls + the definition
    "all four rename paths (name field, ⋯ menu, library reconcile, ⟳ refresh) go through setStopName");
})();

console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
