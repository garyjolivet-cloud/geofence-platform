// Standalone Node test suite guarding backend/worker.js's deleteProjectRows()
// against the recurring "forgot to clear a child table" bug. This repo has no
// test runner/package.json -- run directly: `node tests/delete-project-rows-fk.test.js`
// (or `node --test tests/`, matching kalman-filter.test.js's convention).
//
// Background: deleteProjectRows() manually DELETEs from every table that
// holds a project's data before it can `DELETE FROM project`. D1 enforces
// foreign keys at runtime, so any table with a hard `REFERENCES project(id)`
// FK that the function forgets makes project deletion fail outright with
// `D1_ERROR: FOREIGN KEY constraint failed`. This has now happened at least
// twice (event/published_bundle only -> +5 tables; then again for
// record_schedule/terrain_cell/tile_fog_cell added in migrations 0029/0051/0053).
//
// This test derives the required table list straight from migrations/*.sql
// (walked in order, honouring CREATE/DROP/RENAME) instead of hard-coding it,
// so a future migration that adds a new project(id) FK fails this test until
// deleteProjectRows() is updated to match.
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.log("FAIL:", msg); }
}

const ROOT = path.join(__dirname, "..");
const MIG_DIR = path.join(ROOT, "migrations");
const WORKER = path.join(ROOT, "backend", "worker.js");

// A hard FK to the project table, column-level or table-level, e.g.
//   projectId TEXT NOT NULL REFERENCES project(id)
//   FOREIGN KEY (project_id) REFERENCES project(id)
// Deliberately anchored on `project(` so it never matches project_link,
// project_guide, project_frontdesk, etc.
const PROJECT_FK = /REFERENCES\s+project\s*\(\s*id\s*\)/i;

function stripSqlComments(sql) {
  return sql.replace(/--[^\n]*/g, "");
}

// ---- 1. Walk every migration in order; track which live tables carry a
//         project(id) FK. CREATE (with the FK) adds, DROP removes,
//         ALTER ... RENAME TO carries the flag across a table rebuild. ----
const migFiles = fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
assert(migFiles.length > 0, "found migration files to scan");

const fkTables = new Map(); // liveTableName -> migration file that introduced the FK

for (const f of migFiles) {
  const sql = stripSqlComments(fs.readFileSync(path.join(MIG_DIR, f), "utf8"));
  for (const raw of sql.split(";")) {
    const stmt = raw.trim();
    if (!stmt) continue;
    let m;
    if ((m = stmt.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`\[]?([A-Za-z_][A-Za-z0-9_]*)["'`\]]?/i))) {
      if (PROJECT_FK.test(stmt)) fkTables.set(m[1], f);
    } else if ((m = stmt.match(/^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`\[]?([A-Za-z_][A-Za-z0-9_]*)["'`\]]?/i))) {
      fkTables.delete(m[1]);
    } else if ((m = stmt.match(/^ALTER\s+TABLE\s+["'`\[]?([A-Za-z_][A-Za-z0-9_]*)["'`\]]?\s+RENAME\s+TO\s+["'`\[]?([A-Za-z_][A-Za-z0-9_]*)["'`\]]?/i))) {
      if (fkTables.has(m[1])) { fkTables.set(m[2], fkTables.get(m[1])); fkTables.delete(m[1]); }
    }
  }
}

// Guard against a silently-broken scanner making the real assertions vacuous:
// these six are known to carry a project(id) FK today.
for (const must of ["published_bundle", "event", "record_session", "record_schedule", "terrain_cell", "tile_fog_cell"]) {
  assert(fkTables.has(must), `migration scanner detected "${must}" as a project(id) FK table`);
}

// ---- 2. Extract the body of deleteProjectRows() by brace-matching ----
const worker = fs.readFileSync(WORKER, "utf8");
const fnStart = worker.indexOf("async function deleteProjectRows");
assert(fnStart !== -1, "found deleteProjectRows() in worker.js");

const openBrace = worker.indexOf("{", fnStart);
let depth = 0, end = -1;
for (let i = openBrace; i < worker.length && openBrace !== -1; i++) {
  const c = worker[i];
  if (c === "{") depth++;
  else if (c === "}" && --depth === 0) { end = i; break; }
}
assert(end !== -1, "brace-matched the deleteProjectRows() body");
const body = end !== -1 ? worker.slice(openBrace, end + 1) : "";

// ---- 3. Every project(id) FK table must be cleared, and the project row
//         itself must be deleted after all of them. ----
const projRowIdx = body.search(/DELETE\s+FROM\s+project\s+WHERE\s+id\s*=/i);
assert(projRowIdx !== -1, "deleteProjectRows() deletes the project row itself");

for (const [table, mig] of fkTables) {
  const idx = body.search(new RegExp(`DELETE\\s+FROM\\s+${table}\\b`, "i"));
  assert(idx !== -1,
    `deleteProjectRows() clears "${table}" (has REFERENCES project(id), from ${mig})`);
  assert(idx !== -1 && projRowIdx !== -1 && idx < projRowIdx,
    `"${table}" is cleared BEFORE the project row (FK-ordering)`);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
