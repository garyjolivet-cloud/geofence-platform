// Legal notice (2026-10-06): "Ridge Quest is the company and name to be protected. Gary Jolivet owns
// the company." App: Account -> ⚖ Legal (+ the copyright line); help page footer; repo LICENSE,
// README / SECURITY footers, package.json UNLICENSED.
// Run: `node --test tests/legal-notice.test.js` (or the full suite).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const read = f => fs.readFileSync(path.join(__dirname, "..", f), "utf8").replace(/\r/g, "");
const rq = read("frontend/ridge-quest.html");
const LINE = "© 2026 Ridge Quest. All rights reserved.";

test("app: Legal screen from Account, with the copyright line under it", () => {
  assert.ok(rq.includes('const RQ_COPYRIGHT = "' + LINE + '";'));
  const home = rq.slice(rq.indexOf("function renderHome(){"), rq.indexOf("// The rider's own chute names (cached copy"));
  const acct = home.slice(home.indexOf('details class="acct"'));
  assert.ok(/id="btnLegal">⚖ Legal<\/button>/.test(acct) && /class="legalLine">'\+RQ_COPYRIGHT\+'/.test(acct), "inside the folded Account");
  assert.ok(/getElementById\("btnLegal"\)\.onclick=\(\)=>renderLegal\(\);/.test(rq));
  const legal = rq.slice(rq.indexOf("function renderLegal(){"), rq.indexOf("/* ========================= ONBOARDING GATE"));
  assert.ok(/trademarks of Ridge Quest, owned by Gary Jolivet/.test(legal));
  assert.ok(/not affiliated with or endorsed by any ski resort/.test(legal) && /Esri, Maxar/.test(legal));
  assert.ok(/GATE_SCOPES\.map/.test(legal), "the sign-up notices can be re-read");
  assert.ok(/lgBack"\)\.onclick=renderHome/.test(legal));
});

test("help page footer and repository carry the notice", () => {
  assert.ok(read("frontend/ridge-quest-help.html").includes(LINE + " Ridge Quest™ is a trademark of Ridge Quest, owned by Gary Jolivet."));
  const lic = read("LICENSE");
  assert.ok(/^Copyright \(c\) 2026 Ridge Quest\. All rights reserved\./.test(lic) && /owned by Gary Jolivet/.test(lic) && /No licence is granted/.test(lic));
  ["README.md", "SECURITY.md"].forEach(f => assert.ok(read(f).includes(LINE + " Ridge Quest™ is a trademark of Ridge Quest, owned by Gary Jolivet."), f));
  const pkg = JSON.parse(read("package.json"));
  assert.strictEqual(pkg.license, "UNLICENSED"); assert.strictEqual(pkg.private, true);
});
