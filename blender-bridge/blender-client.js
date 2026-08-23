// Thin TCP JSON-command client for blender_addon.py's socket server.
// Shared by mcp-server.js (stdio MCP tools) and http-bridge.js (the
// texture-gen helper), so the wire protocol only exists in one place.

import net from "node:net";
import crypto from "node:crypto";

const HOST = "127.0.0.1";
const PORT = 9876;
const COMMAND_TIMEOUT_MS = 30000;

let socket = null;
let buffer = "";
const pending = new Map(); // id -> {resolve, reject, timer}

function ensureConnected() {
  if (socket && !socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket = net.createConnection({ host: HOST, port: PORT }, () => resolve());
    socket.on("data", onData);
    socket.on("error", (err) => {
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(err);
        pending.delete(id);
      }
      reject(err);
    });
    socket.on("close", () => {
      socket = null;
    });
  });
}

function onData(chunk) {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      continue;
    }
    const p = pending.get(msg.id);
    if (!p) continue;
    clearTimeout(p.timer);
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || "blender command failed"));
  }
}

// send(cmd, args) -> Promise<result>. Rejects on error or after
// COMMAND_TIMEOUT_MS with no response (e.g. Blender addon not running).
async function send(cmd, args) {
  await ensureConnected();
  const id = crypto.randomUUID();
  const payload = JSON.stringify({ id, cmd, args: args || {} }) + "\n";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`blender command "${cmd}" timed out after ${COMMAND_TIMEOUT_MS}ms — is blender_addon.py running inside Blender?`));
    }, COMMAND_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    socket.write(payload);
  });
}

export { send };
