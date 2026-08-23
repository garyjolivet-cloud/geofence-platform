// Local HTTP bridge for Object Studio's "Generate" button
// (frontend/object-studio.html). Runs a headless Claude Code session driving
// the blender-* MCP tools (mcp-server.js -> blender_addon.py), then streams
// the resulting .glb back to the browser. Staff-only / local-machine-only —
// see ../.claude/plans (Object Studio plan) for the full architecture.
//
// NOTE: the exact `claude -p` CLI flags below (--mcp-config, --allowedTools,
// --permission-mode) should be double-checked against whatever Claude Code
// CLI version is actually installed before relying on this — flag names do
// shift between releases. Adjust CLAUDE_ARGS accordingly if the run fails
// with an "unknown flag" error.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXPORTS_DIR = path.join(__dirname, "exports");
const CURRENT_GLB = path.join(EXPORTS_DIR, "current.glb");
const PORT = 8791;
const GENERATE_TIMEOUT_MS = 5 * 60 * 1000; // headless agent run, generous

// wrangler dev's port bumps between restarts (confirmed repo habit — see
// CLAUDE.md/project memory), so this can't be a fixed-port allowlist: any
// loopback origin is trusted (this bridge only ever listens on 127.0.0.1
// itself, so only something already running on this machine can reach it),
// plus the deployed origin from wrangler.jsonc's ALLOWED_ORIGIN for staff
// using the live site with a local Blender session.
const DEPLOYED_ORIGIN = "https://geofence-platform.gary-jolivet.workers.dev";
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (origin === DEPLOYED_ORIGIN) return true;
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

function corsHeaders(origin) {
  const h = { "access-control-allow-methods": "GET,POST,DELETE,OPTIONS", "access-control-allow-headers": "content-type" };
  if (isAllowedOrigin(origin)) h["access-control-allow-origin"] = origin;
  return h;
}

function buildPrompt(userPrompt) {
  return [
    `You are driving Blender through the blender_* MCP tools to build a single low-poly, stylized 3D prop for an outdoor geofence tour app.`,
    `Requested object: "${userPrompt}"`,
    ``,
    `Steps:`,
    `1. Call blender_clear_scene first.`,
    `2. Compose the object from primitives (blender_create_primitive) plus modifiers (blender_modifier_add) as needed. Keep it a single coherent object roughly 0.2-3 meters in size, centered near the origin.`,
    `3. Give it a real surface using blender_generate_and_apply_texture (preferred) or blender_set_material_color if a flat color is more appropriate.`,
    `4. Optionally call blender_viewport_screenshot to check your work and adjust.`,
    `5. Call blender_export_glb with no filename argument (so it writes to the default current.glb path) as your LAST action.`,
    `Do not ask any clarifying questions — make reasonable choices and proceed autonomously.`,
  ].join("\n");
}

function runClaudeHeadless(userPrompt) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", buildPrompt(userPrompt),
      "--mcp-config", path.join(REPO_ROOT, ".mcp.json"),
      "--allowedTools", "mcp__object-studio-blender__*",
      "--permission-mode", "acceptEdits",
    ];
    const child = spawn("claude", args, { cwd: REPO_ROOT });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude -p timed out after ${GENERATE_TIMEOUT_MS}ms`));
    }, GENERATE_TIMEOUT_MS);
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`claude -p exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

async function handleGenerate(req, res, origin) {
  let body = "";
  for await (const chunk of req) body += chunk;
  let prompt;
  try {
    prompt = (JSON.parse(body || "{}").prompt || "").trim();
  } catch (e) {
    res.writeHead(400, corsHeaders(origin));
    return res.end(JSON.stringify({ error: "invalid JSON body" }));
  }
  if (!prompt) {
    res.writeHead(400, corsHeaders(origin));
    return res.end(JSON.stringify({ error: "prompt required" }));
  }
  await fs.mkdir(EXPORTS_DIR, { recursive: true });
  try {
    await runClaudeHeadless(prompt);
  } catch (err) {
    res.writeHead(502, corsHeaders(origin));
    return res.end(JSON.stringify({ error: String(err.message || err) }));
  }
  let glb;
  try {
    glb = await fs.readFile(CURRENT_GLB);
  } catch (err) {
    res.writeHead(502, corsHeaders(origin));
    return res.end(JSON.stringify({ error: "generation finished but current.glb was not produced" }));
  }
  res.writeHead(200, { ...corsHeaders(origin), "content-type": "model/gltf-binary" });
  res.end(glb);
}

async function handleGetCurrent(req, res, origin) {
  try {
    const glb = await fs.readFile(CURRENT_GLB);
    res.writeHead(200, { ...corsHeaders(origin), "content-type": "model/gltf-binary" });
    res.end(glb);
  } catch (err) {
    res.writeHead(404, corsHeaders(origin));
    res.end(JSON.stringify({ error: "no current generation" }));
  }
}

async function handleDeleteCurrent(req, res, origin) {
  try {
    await fs.unlink(CURRENT_GLB);
  } catch (err) {
    // already gone — fine, DELETE is idempotent
  }
  res.writeHead(204, corsHeaders(origin));
  res.end();
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(origin));
    return res.end();
  }
  try {
    if (req.method === "POST" && req.url === "/generate") return await handleGenerate(req, res, origin);
    if (req.method === "GET" && req.url === "/exports/current.glb") return await handleGetCurrent(req, res, origin);
    if (req.method === "DELETE" && req.url === "/exports/current") return await handleDeleteCurrent(req, res, origin);
    res.writeHead(404, corsHeaders(origin));
    res.end(JSON.stringify({ error: "not found" }));
  } catch (err) {
    res.writeHead(500, corsHeaders(origin));
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[object-studio] http bridge listening on http://127.0.0.1:${PORT}`);
});
