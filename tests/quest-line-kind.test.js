// A tapped line is named by its TYPE (2026-10-09, Gary: Tear Drop, a run, read "black - ski_chute - 173m":
// "if its a run dont call it a chute"). "ski_chute" is the GPX Editor's code for the activity
// "Ski / downhill" and must never reach a rider. Same words on the phone and in Test Mode.
// Run: `node --test tests/quest-line-kind.test.js` (or the full suite).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const read = f => fs.readFileSync(path.join(__dirname, "../frontend/" + f), "utf8").replace(/\r/g, "");
const g = {}; new Function("window", read("quest-core.js"))(g);
const kind = g.QuestCore.lineKindLabel;

test("the word comes from the line type, never the activity code", () => {
  assert.strictEqual(kind("run", "ski_chute"), "run", "Tear Drop");
  assert.strictEqual(kind("chute", "ski_chute"), "chute");
  assert.strictEqual(kind(undefined, undefined), "run", "untyped = a run");
  assert.strictEqual(kind("lift", "ski_chute"), "lift");
  assert.strictEqual(kind("hike", "hike"), "boot pack");
  assert.strictEqual(kind("run", "bike"), "bike");
  assert.strictEqual(kind("run", "xcountry"), "cross-country");
  assert.strictEqual(kind("run", "walking_city"), "walk");
  ["run", "chute", "lift", "hike", undefined].forEach(t => ["ski_chute", "hike", "bike", "xcountry", "walking_city", undefined].forEach(a =>
    assert.ok(!/_/.test(kind(t, a)), t + "/" + a)));
});

test("the phone's popup and both Test Mode popups use it", () => {
  const rq = read("ridge-quest.html"), fe = read("fence-editor.html");
  const pop = rq.slice(rq.indexOf("function showRunPopup("), rq.indexOf("function showRunPopup(") + 1500);
  assert.ok(pop.includes("const act = QuestCore.lineKindLabel(p.runType, p.activityType);"));
  assert.strictEqual((fe.match(/const act=QuestCore\.lineKindLabel\(p\.runType, p\.activityType\);/g) || []).length, 2, "one line, and several lines under one tap");
  assert.ok(!/act\s*=\s*p\.activityType\s*\|\|/.test(rq + fe), "no popup prints the raw activity code");
});
