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
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { send as blenderSend } from "./blender-client.js";
import JSZip from "jszip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXPORTS_DIR = path.join(__dirname, "exports");
const FONTS_DIR = path.join(__dirname, "fonts"); // ephemeral per-upload files (gitignored)
const FONT_PRESETS_DIR = path.join(__dirname, "font-presets"); // committed, permanent
const TEXTURES_DIR = path.join(__dirname, "textures");
const CURRENT_GLB = path.join(EXPORTS_DIR, "current.glb");
const PORT = 8791;
const GENERATE_TIMEOUT_MS = 5 * 60 * 1000; // headless agent run, generous
const MAX_FONT_BYTES = 5 * 1024 * 1024;
const MAX_TEXTURE_BYTES = 15 * 1024 * 1024;

// Bundled trail-sign-style fonts (Google Fonts, OFL-licensed — see the
// matching *-OFL.txt next to each file) selectable straight from the
// dropdown, no upload needed. Add more by dropping a .ttf/.otf into
// font-presets/ and adding a line here.
const FONT_PRESETS = {
  rye: "Rye-Regular.ttf",
  sancreek: "Sancreek-Regular.ttf",
  ranchers: "Ranchers-Regular.ttf",
  alfaslabone: "AlfaSlabOne-Regular.ttf",
  anton: "Anton-Regular.ttf",
  bebasneue: "BebasNeue-Regular.ttf",
};

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

function buildPrompt(userPrompt, keepScene) {
  const steps = [];
  if (keepScene) {
    steps.push(`Call blender_get_scene_info first to see what's already in the scene. Do NOT call blender_clear_scene — the user is adding this as an additional object alongside what's already there. Give your new object(s) distinct names that won't collide with existing ones.`);
  } else {
    steps.push(`Call blender_clear_scene first.`);
  }
  steps.push(
    `Compose the object from primitives (blender_create_primitive) plus modifiers (blender_modifier_add) as needed. Keep it a single coherent object roughly 0.2-3 meters in size, centered near the origin.`,
    `Give it a real surface using blender_generate_and_apply_texture (preferred) or blender_set_material_color if a flat color is more appropriate.`,
    `Optionally call blender_viewport_screenshot to check your work and adjust.`,
    `Call blender_export_glb with no arguments (so it exports every mesh object currently in the scene, and writes to the default current.glb path) as your LAST action.`,
  );
  return [
    `You are driving Blender through the blender_* MCP tools to build a single low-poly, stylized 3D prop for an outdoor geofence tour app.`,
    `Requested object: "${userPrompt}"`,
    ``,
    `Steps:`,
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    `Do not ask any clarifying questions — make reasonable choices and proceed autonomously.`,
  ].join("\n");
}

function runClaudeHeadless(userPrompt, keepScene) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", buildPrompt(userPrompt, keepScene),
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

async function sendCurrentGlb(res, origin, extraHeaders) {
  let glb;
  try {
    glb = await fs.readFile(CURRENT_GLB);
  } catch (err) {
    res.writeHead(502, corsHeaders(origin));
    return res.end(JSON.stringify({ error: "generation finished but current.glb was not produced" }));
  }
  res.writeHead(200, { ...corsHeaders(origin), "content-type": "model/gltf-binary", ...(extraHeaders || {}) });
  res.end(glb);
}

async function handleGenerate(req, res, origin) {
  let body = "";
  for await (const chunk of req) body += chunk;
  let parsed;
  try {
    parsed = JSON.parse(body || "{}");
  } catch (e) {
    res.writeHead(400, corsHeaders(origin));
    return res.end(JSON.stringify({ error: "invalid JSON body" }));
  }
  const prompt = (parsed.prompt || "").trim();
  if (!prompt) {
    res.writeHead(400, corsHeaders(origin));
    return res.end(JSON.stringify({ error: "prompt required" }));
  }
  await fs.mkdir(EXPORTS_DIR, { recursive: true });
  try {
    await runClaudeHeadless(prompt, !!parsed.keepScene);
  } catch (err) {
    res.writeHead(502, corsHeaders(origin));
    return res.end(JSON.stringify({ error: String(err.message || err) }));
  }
  await sendCurrentGlb(res, origin);
}

// base64 byte-length without decoding: 4 chars encode 3 bytes, minus padding.
function base64ByteLength(b64) {
  const len = b64.length;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

async function writeUploadedFile(dir, upload) {
  const ext = path.extname(upload.filename || "") || "";
  const filePath = path.join(dir, crypto.randomUUID() + ext);
  await fs.writeFile(filePath, Buffer.from(upload.dataBase64, "base64"));
  return filePath;
}

// Shader-based material presets — pure Principled BSDF parameters, no image
// needed. `tint` is the user's color-picker value (defaults per-preset).
const MATERIAL_PRESETS = {
  metallic: (tint) => ({ color: tint || [0.8, 0.82, 0.85, 1.0], metallic: 1.0, roughness: 0.25 }),
  glass: (tint) => ({ color: tint || [0.9, 0.95, 1.0, 1.0], metallic: 0.0, roughness: 0.02, transmission: 1.0, ior: 1.45 }),
  neon: (tint) => ({
    color: tint || [1.0, 0.3, 0.6, 1.0], metallic: 0.0, roughness: 0.4,
    emission_color: tint || [1.0, 0.3, 0.6, 1.0], emission_strength: 8.0,
  }),
};

// Image-based presets — an AI-generated texture (via the existing
// /api/texture-gen endpoint, same one the free-text Generate flow uses)
// applied the same way an uploaded texture would be.
const AI_TEXTURE_PRESETS = {
  rusty: "heavily rusted corroded metal surface texture, seamless, weathered orange-brown rust, pitted, high detail",
  worn_wood: "old worn weathered wood plank texture, seamless, cracked grain, faded, high detail",
};

async function generateAiTexture(prompt, workerBaseUrl) {
  const base = (workerBaseUrl || "http://127.0.0.1:8787").replace(/\/$/, "");
  const res = await fetch(base + "/api/texture-gen", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) throw new Error(`texture-gen failed: ${res.status} ${await res.text().catch(() => "")}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const imagePath = path.join(TEXTURES_DIR, crypto.randomUUID() + ".png");
  await fs.writeFile(imagePath, buf);
  return imagePath;
}

// Applies one of: flat color ("color", the default), a user-uploaded image
// ("upload"), a shader preset (MATERIAL_PRESETS key), or an AI-generated
// texture preset (AI_TEXTURE_PRESETS key) to `objectName`. `uploadPath` is
// the already-disk-written path for an "upload" surface (or null otherwise).
async function applySurface(objectName, surface, { color, roughness, metallic, uploadPath, workerBaseUrl }) {
  if (surface === "upload") {
    if (!uploadPath) throw new Error(`${objectName}: surface "upload" selected but no file was provided`);
    await blenderSend("apply_image_texture", { object: objectName, image_path: uploadPath });
  } else if (surface in MATERIAL_PRESETS) {
    await blenderSend("set_material_color", { object: objectName, ...MATERIAL_PRESETS[surface](color) });
  } else if (surface in AI_TEXTURE_PRESETS) {
    const imagePath = await generateAiTexture(AI_TEXTURE_PRESETS[surface], workerBaseUrl);
    await blenderSend("apply_image_texture", { object: objectName, image_path: imagePath });
  } else {
    const args = { object: objectName, color: color || [0.8, 0.8, 0.8, 1.0] };
    if (roughness !== undefined) args.roughness = roughness;
    if (metallic !== undefined) args.metallic = metallic;
    await blenderSend("set_material_color", args);
  }
}

async function handleCreateTextSign(req, res, origin) {
  let body = "";
  for await (const chunk of req) body += chunk;
  let data;
  try {
    data = JSON.parse(body || "{}");
  } catch (e) {
    res.writeHead(400, corsHeaders(origin));
    return res.end(JSON.stringify({ error: "invalid JSON body" }));
  }
  const text = (data.text || "").trim();
  if (!text) {
    res.writeHead(400, corsHeaders(origin));
    return res.end(JSON.stringify({ error: "text required" }));
  }
  const board = data.board || {};
  const boardSurface = board.surface || "color";
  const textSurface = data.textSurface || "color";
  for (const [label, upload, max] of [
    ["font", data.font, MAX_FONT_BYTES],
    ["board texture", board.texture, MAX_TEXTURE_BYTES],
    ["text texture", data.textTexture, MAX_TEXTURE_BYTES],
  ]) {
    if (upload && base64ByteLength(upload.dataBase64 || "") > max) {
      res.writeHead(400, corsHeaders(origin));
      return res.end(JSON.stringify({ error: `${label} exceeds ${Math.round(max / 1024 / 1024)}MB limit` }));
    }
  }

  await fs.mkdir(EXPORTS_DIR, { recursive: true });
  await fs.mkdir(FONTS_DIR, { recursive: true });
  await fs.mkdir(TEXTURES_DIR, { recursive: true });

  try {
    const fontPath = data.fontPreset && FONT_PRESETS[data.fontPreset]
      ? path.join(FONT_PRESETS_DIR, FONT_PRESETS[data.fontPreset])
      : data.font ? await writeUploadedFile(FONTS_DIR, data.font) : null;
    const boardTexPath = board.enabled && boardSurface === "upload" && board.texture
      ? await writeUploadedFile(TEXTURES_DIR, board.texture) : null;
    const textTexPath = !board.enabled && textSurface === "upload" && data.textTexture
      ? await writeUploadedFile(TEXTURES_DIR, data.textTexture) : null;

    if (!data.keepScene) await blenderSend("clear_scene", {});
    // Suffix each generation's object names so repeated additions in
    // keepScene mode never collide with a prior generation's objects.
    const suffix = crypto.randomUUID().slice(0, 8);
    const textName = `sign_text_${suffix}`;
    const boardName = `sign_board_${suffix}`;
    const t = await blenderSend("create_text", {
      text,
      font_path: fontPath,
      size: data.size ?? 1.0,
      extrude: data.extrude ?? 0.0,
      bevel_depth: data.bevelDepth ?? 0.0,
      bevel_resolution: data.bevelResolution ?? 0,
      space_character: data.spaceCharacter ?? 1.0,
      space_word: data.spaceWord ?? 1.0,
      space_line: data.spaceLine ?? 1.0,
      align_x: data.alignX || "CENTER",
      align_y: data.alignY || "CENTER",
      name: textName,
    });

    if (board.enabled) {
      // Board on: text is always a plain flat color; the board carries
      // whichever surface (color/upload/preset) was selected.
      await blenderSend("set_material_color", {
        object: textName,
        color: data.textColor || [0.9, 0.9, 0.85, 1.0],
        roughness: data.textRoughness ?? 0.6,
        metallic: data.textMetallic ?? 0.0,
      });

      const paddingPct = board.paddingPct ?? 0.2;
      const thickness = board.thickness ?? 0.03;
      const offset = board.offset ?? 0.01;
      const boardWidth = t.dimensions[0] * (1 + paddingPct);
      const boardHeight = t.dimensions[1] * (1 + paddingPct);
      // Board is placed with its FRONT face at this Z, then SOLIDIFY's
      // default offset=-1 recedes the added thickness behind that point
      // (confirmed empirically — see the plan's verification step 1).
      const boardZ = t.bbox_center[2] - (data.extrude ?? 0.0) - offset;
      await blenderSend("create_primitive", {
        type: "plane",
        size: 1,
        scale: [boardWidth, boardHeight, 1],
        location: [t.bbox_center[0], t.bbox_center[1], boardZ],
        name: boardName,
      });
      await blenderSend("modifier_add", { object: boardName, type: "SOLIDIFY", params: { thickness }, apply: true });
      await applySurface(boardName, boardSurface, {
        color: board.color || [0.45, 0.3, 0.18, 1.0],
        uploadPath: boardTexPath,
        workerBaseUrl: data.workerBaseUrl,
      });
    } else {
      // Board off: text itself carries whichever surface was selected.
      await applySurface(textName, textSurface, {
        color: data.textColor || [0.9, 0.9, 0.85, 1.0],
        roughness: data.textRoughness ?? 0.6,
        metallic: data.textMetallic ?? 0.0,
        uploadPath: textTexPath,
        workerBaseUrl: data.workerBaseUrl,
      });
    }

    // Export everything currently in the scene, not just this generation's
    // objects — in keepScene mode that includes earlier additions too.
    await blenderSend("export_glb", { path: CURRENT_GLB });

    const extraHeaders = {};
    if (t.font_warning) extraHeaders["x-font-warning"] = encodeURIComponent(t.font_warning);
    await sendCurrentGlb(res, origin, extraHeaders);
  } catch (err) {
    res.writeHead(502, corsHeaders(origin));
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
}

async function handleDeleteObject(req, res, origin) {
  let body = "";
  for await (const chunk of req) body += chunk;
  let data;
  try {
    data = JSON.parse(body || "{}");
  } catch (e) {
    res.writeHead(400, corsHeaders(origin));
    return res.end(JSON.stringify({ error: "invalid JSON body" }));
  }
  if (!data.object) {
    res.writeHead(400, corsHeaders(origin));
    return res.end(JSON.stringify({ error: "object required" }));
  }
  try {
    await blenderSend("delete_object", { object: data.object });
    await blenderSend("export_glb", { path: CURRENT_GLB });
    await sendCurrentGlb(res, origin);
  } catch (err) {
    res.writeHead(502, corsHeaders(origin));
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
}

async function handleTransformObject(req, res, origin) {
  let body = "";
  for await (const chunk of req) body += chunk;
  let data;
  try {
    data = JSON.parse(body || "{}");
  } catch (e) {
    res.writeHead(400, corsHeaders(origin));
    return res.end(JSON.stringify({ error: "invalid JSON body" }));
  }
  if (!data.object) {
    res.writeHead(400, corsHeaders(origin));
    return res.end(JSON.stringify({ error: "object required" }));
  }
  try {
    const args = { object: data.object };
    if (data.scaleFactor !== undefined) args.scale_factor = data.scaleFactor;
    if (data.scale !== undefined) args.scale = data.scale;
    if (data.location !== undefined) args.location = data.location;
    if (data.rotationDeg !== undefined) args.rotation_deg = data.rotationDeg;
    await blenderSend("transform_object", args);
    await blenderSend("export_glb", { path: CURRENT_GLB });
    await sendCurrentGlb(res, origin);
  } catch (err) {
    res.writeHead(502, corsHeaders(origin));
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
}

async function handleClearScene(req, res, origin) {
  try {
    await blenderSend("clear_scene", {});
    try { await fs.unlink(CURRENT_GLB); } catch (e) { /* already gone, fine */ }
    res.writeHead(204, corsHeaders(origin));
    res.end();
  } catch (err) {
    res.writeHead(502, corsHeaders(origin));
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
}

async function handleExportMergedObj(req, res, origin) {
  const objDir = path.join(EXPORTS_DIR, "obj-" + crypto.randomUUID());
  try {
    await fs.mkdir(objDir, { recursive: true });
    const objPath = path.join(objDir, "merged.obj");
    await blenderSend("export_obj", { path: objPath, join: true });
    const files = await fs.readdir(objDir);
    if (!files.length) throw new Error("export finished but no files were produced");
    const zip = new JSZip();
    for (const f of files) {
      zip.file(f, await fs.readFile(path.join(objDir, f)));
    }
    const zipBuf = await zip.generateAsync({ type: "nodebuffer" });
    res.writeHead(200, { ...corsHeaders(origin), "content-type": "application/zip" });
    res.end(zipBuf);
  } catch (err) {
    res.writeHead(502, corsHeaders(origin));
    res.end(JSON.stringify({ error: String(err.message || err) }));
  } finally {
    await fs.rm(objDir, { recursive: true, force: true }).catch(() => {});
  }
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
    if (req.method === "POST" && req.url === "/create-text-sign") return await handleCreateTextSign(req, res, origin);
    if (req.method === "POST" && req.url === "/delete-object") return await handleDeleteObject(req, res, origin);
    if (req.method === "POST" && req.url === "/transform-object") return await handleTransformObject(req, res, origin);
    if (req.method === "POST" && req.url === "/clear-scene") return await handleClearScene(req, res, origin);
    if (req.method === "POST" && req.url === "/export-merged-obj") return await handleExportMergedObj(req, res, origin);
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
