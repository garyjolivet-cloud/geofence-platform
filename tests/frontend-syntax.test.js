// Every inline <script> in every frontend page, and every frontend .js file, must parse.
// 2026-09-30: a Publish warning string in fence-editor.html was written with real line breaks
// inside a "..." string. One syntax error stops the whole page script, so the Fence Editor
// opened to a black map with no stops. The unit tests only extracted single functions and
// never parsed the whole script, so nothing caught it.
//
// Run: `node --test tests/frontend-syntax.test.js`
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const test = require("node:test");
const assert = require("node:assert");

const dir = path.join(__dirname, "../frontend");

test("every inline page script parses", () => {
  const problems = [];
  let checked = 0;
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(dir, f), "utf8");
    const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
    let m, i = 0;
    while ((m = re.exec(html))) {
      const attrs = m[1], code = m[2];
      i++;
      if (/type\s*=\s*["']?(module|importmap|application\/(ld\+)?json|text\/template)/i.test(attrs) || !code.trim()) continue;
      try { new vm.Script(code, { filename: f + "#script" + i }); checked++; }
      catch (e) { problems.push(f + " script " + i + ": " + e.message); }
    }
  }
  assert.ok(checked > 10, "found the page scripts (" + checked + ")");
  assert.deepStrictEqual(problems, []);
});

test("every frontend .js file parses", () => {
  const problems = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith(".js"))) {
    const code = fs.readFileSync(path.join(dir, f), "utf8");
    if (/^\s*(import|export)\s/m.test(code)) continue; // ES modules are parsed by the browser as modules
    try { new vm.Script(code, { filename: f }); } catch (e) { problems.push(f + ": " + e.message); }
  }
  assert.deepStrictEqual(problems, []);
});
