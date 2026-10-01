// Ridge Quest is a ski app (2026-09-30): no Ski/Hike/XC Ski/Bike/Drive picker on Home,
// tracking is always ski, and a climb (stored as "hike") is shown as "Boot pack".
// Older runs logged as bike / drive / XC ski still get readable labels.
//
// Run: `node --test tests/quest-ski-only.test.js`
"use strict";
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const html = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest.html"), "utf8");
const help = fs.readFileSync(path.join(__dirname, "../frontend/ridge-quest-help.html"), "utf8");

function grab(re, name) { const m = html.match(re); assert.ok(m, "found " + name); return m[0]; }
// eslint-disable-next-line no-new-func
const lib = new Function(
  grab(/const QUEST_ACTIVITIES = \[[\s\S]*?\];/, "QUEST_ACTIVITIES") + "\n" +
  grab(/const QUEST_ACTIVITY_LABELS = \{[\s\S]*?\};/, "QUEST_ACTIVITY_LABELS") + "\n" +
  grab(/function questActivityLabel\(key\)\{[^\n]*\}/, "questActivityLabel") +
  "\nreturn { QUEST_ACTIVITIES, questActivityLabel };")();

test("only Ski and Boot pack are offered", () => {
  assert.deepStrictEqual(lib.QUEST_ACTIVITIES.map(a => a.key), ["ski", "hike"]);
  assert.strictEqual(lib.questActivityLabel("hike"), "Boot pack");
  assert.strictEqual(lib.questActivityLabel("ski"), "Ski");
});

test("older runs keep readable labels", () => {
  assert.strictEqual(lib.questActivityLabel("bike"), "Bike");
  assert.strictEqual(lib.questActivityLabel("drive"), "Drive");
  assert.strictEqual(lib.questActivityLabel("xcski"), "XC Ski");
  assert.strictEqual(lib.questActivityLabel("lift"), "Lift");
});

test("Home has no activity picker and tracking is always ski", () => {
  assert.ok(!/activityPicker|data-activity=/.test(html), "no picker markup");
  assert.ok(!/localStorage\.(get|set)Item\("rq\.activity"/.test(html), "the old remembered choice is never read or written");
  assert.ok(/const selectedActivity = "ski";/.test(html), "Home tracks as ski");
});

test("the classifier has no manual bike / drive / xcski branches", () => {
  const s = html.indexOf("_classifyAndLog(corridor, buffer, selectedActivity, isFinal){");
  const body = html.slice(s, html.indexOf("let verticalM;", s));
  assert.ok(!/selectedActivity===/.test(body), "no branch reads the selection");
  assert.ok(!/"bike"|"drive"|"xcski"/.test(body), "no bike / drive / xcski outcomes");
});

test("the help page offers no activity choice", () => {
  assert.ok(!/Choose your activity/.test(help));
  assert.ok(!/>Bike<|>Drive<|XC&nbsp;Ski|XC Ski/.test(help), "no Bike / Drive / XC Ski");
  assert.ok(/Boot pack/.test(help), "explains Boot pack");
});
