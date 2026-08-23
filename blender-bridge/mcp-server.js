// Object Studio's Blender-control MCP server. Registered with Claude Code
// via ../.mcp.json — usable directly from chat ("use the blender tools to
// make a bench") and by http-bridge.js's headless `claude -p` runs for the
// web module's Generate button. Every tool here is a thin wrapper over one
// blender_addon.py socket command (see blender-client.js for the wire
// protocol) — this file owns naming/schema/descriptions only.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as blender from "./blender-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORTS_DIR = path.join(__dirname, "exports");
const TEXTURES_DIR = path.join(__dirname, "textures");

async function ensureDirs() {
  await fs.mkdir(EXPORTS_DIR, { recursive: true });
  await fs.mkdir(TEXTURES_DIR, { recursive: true });
}

function textResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

const server = new McpServer({ name: "object-studio-blender", version: "1.0.0" });

server.tool(
  "blender_clear_scene",
  "Remove every mesh object from the current Blender scene. Call this first when starting a brand-new object so leftover geometry from a previous generation doesn't get exported alongside it.",
  {},
  async () => textResult(await blender.send("clear_scene", {}))
);

server.tool(
  "blender_create_primitive",
  "Create one primitive mesh (cube, sphere, cylinder, cone, plane, or torus) in the Blender scene, positioned/scaled/rotated as given. Compose several primitives (plus blender_modifier_add) to build compound objects like a bench, signpost, or crate.",
  {
    type: z.enum(["cube", "sphere", "cylinder", "cone", "plane", "torus"]),
    name: z.string().optional().describe("Object name to assign; defaults to Blender's auto-generated name."),
    location: z.array(z.number()).length(3).optional().describe("[x,y,z] in meters, default [0,0,0]."),
    scale: z.array(z.number()).length(3).optional().describe("[x,y,z] scale factors, default [1,1,1]."),
    rotation_deg: z.array(z.number()).length(3).optional().describe("[x,y,z] rotation in degrees, default [0,0,0]."),
    size: z.number().optional().describe("cube/plane edge length."),
    radius: z.number().optional().describe("sphere/cylinder/cone radius."),
    depth: z.number().optional().describe("cylinder/cone height."),
    segments: z.number().optional().describe("radial segment count."),
    major_radius: z.number().optional().describe("torus major radius."),
    minor_radius: z.number().optional().describe("torus minor radius."),
    smooth: z.boolean().optional().describe("apply shade-smooth to this object."),
  },
  async (args) => textResult(await blender.send("create_primitive", args))
);

server.tool(
  "blender_modifier_add",
  "Add a modifier (BEVEL, MIRROR, ARRAY, SOLIDIFY, or BOOLEAN) to an existing object, optionally applying it immediately so it's baked into the mesh before export.",
  {
    object: z.string(),
    type: z.enum(["BEVEL", "MIRROR", "ARRAY", "SOLIDIFY", "BOOLEAN"]),
    params: z.record(z.any()).optional().describe("Modifier-specific properties, e.g. {width:0.02,segments:3} for BEVEL, {count:4} for ARRAY, {operation:'UNION',object:'Cube.001'} for BOOLEAN."),
    apply: z.boolean().optional().describe("Bake the modifier into the mesh immediately (recommended before export_glb)."),
  },
  async (args) => textResult(await blender.send("modifier_add", args))
);

server.tool(
  "blender_set_material_color",
  "Assign a flat/solid Principled-BSDF material color to an object (no image texture).",
  {
    object: z.string(),
    color: z.array(z.number()).length(4).describe("[r,g,b,a] each 0-1."),
    roughness: z.number().min(0).max(1).optional(),
    metallic: z.number().min(0).max(1).optional(),
  },
  async (args) => textResult(await blender.send("set_material_color", args))
);

server.tool(
  "blender_generate_and_apply_texture",
  "Generate a texture image from a text prompt (via this app's Workers AI text-to-image endpoint) and apply it as the given object's material — UV-unwraps the object and wires the generated image into its Base Color. Use this to give a generated object a real photographic-looking surface instead of a flat color.",
  {
    object: z.string(),
    prompt: z.string().describe("Description of the texture/surface to generate, e.g. 'weathered wood plank texture, seamless, top-down'."),
    workerBaseUrl: z.string().optional().describe("Base URL of the geofence-platform Worker to call for generation. Defaults to the local dev server."),
  },
  async ({ object, prompt, workerBaseUrl }) => {
    await ensureDirs();
    const base = workerBaseUrl || "http://127.0.0.1:8787";
    const res = await fetch(base.replace(/\/$/, "") + "/api/texture-gen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) throw new Error(`texture-gen failed: ${res.status} ${await res.text().catch(() => "")}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const imagePath = path.join(TEXTURES_DIR, `${Date.now()}.png`);
    await fs.writeFile(imagePath, buf);
    const result = await blender.send("apply_image_texture", { object, image_path: imagePath });
    return textResult({ ...result, image_path: imagePath });
  }
);

server.tool(
  "blender_export_glb",
  "Export the current scene's mesh objects to a .glb file. Object Studio's web module always expects the final result at the fixed 'current' export path unless you're told otherwise.",
  {
    filename: z.string().optional().describe("Filename (no directory) to write inside the bridge's exports folder. Defaults to 'current.glb', which is what the Object Studio web page looks for."),
    objects: z.array(z.string()).optional().describe("Only export these object names; defaults to every mesh object in the scene."),
  },
  async ({ filename, objects }) => {
    await ensureDirs();
    const outPath = path.join(EXPORTS_DIR, filename || "current.glb");
    const result = await blender.send("export_glb", { path: outPath, objects });
    return textResult(result);
  }
);

server.tool(
  "blender_viewport_screenshot",
  "Render the current 3D viewport to a PNG so you can look at the object built so far and decide what to adjust next.",
  {
    filename: z.string().optional().describe("Filename (no directory), defaults to 'screenshot.png' inside the bridge's exports folder."),
  },
  async ({ filename }) => {
    await ensureDirs();
    const outPath = path.join(EXPORTS_DIR, filename || "screenshot.png");
    const result = await blender.send("viewport_screenshot", { path: outPath });
    return { content: [{ type: "image", data: (await fs.readFile(outPath)).toString("base64"), mimeType: "image/png" }] };
  }
);

server.tool(
  "blender_get_scene_info",
  "List every mesh object currently in the Blender scene (name, location, dimensions, modifiers) — useful to check state before deciding the next step.",
  {},
  async () => textResult(await blender.send("get_scene_info", {}))
);

const transport = new StdioServerTransport();
await server.connect(transport);
