# Object Studio — Blender Bridge

Local-only companion for the Object Studio module (`/objects`). Never
deployed — everything here runs on whatever machine has Blender open. See
`C:\Users\garyj\.claude\plans\create-a-new-module-serene-lampson.md` for the
full architecture.

## One-time setup

1. **Install dependencies**: `npm install` in this folder.
2. **Load the Blender addon**: with Blender open, go to the Scripting
   workspace, open `blender_addon.py`, click "Run Script". You should see
   `[object-studio] Blender bridge listening on 127.0.0.1:9876` in Blender's
   system console. Leave Blender open — the socket server stops when the
   script's owning Blender session closes.
3. **Register the MCP server**: `.mcp.json` at the repo root already points
   Claude Code at `blender-bridge/mcp-server.js`. Restart Claude Code (or
   run `/mcp` to reconnect) from the repo root and confirm
   `object-studio-blender` shows up as connected.
4. **Start the HTTP bridge** (only needed for the web page's Generate
   button, not for driving Blender from chat): `npm run bridge` — listens on
   `http://127.0.0.1:8791`.

## Everyday use

- From Claude Code chat, anywhere in this repo: "use the blender tools to
  make me a wooden bench" works directly once the MCP server is connected.
- From the browser: open `/objects`, type a prompt, click Generate — this
  calls the HTTP bridge, which runs a headless `claude -p` session using the
  same MCP tools and streams back `blender-bridge/exports/current.glb`.

## Troubleshooting

- "blender command timed out" from either server means `blender_addon.py`
  isn't running inside Blender (re-run it from the Scripting tab) or
  Blender itself isn't open.
- If `claude -p` in `http-bridge.js` fails with an "unknown flag" error,
  the installed Claude Code CLI's flags have likely shifted since this was
  written — check `claude -p --help` and adjust the `args` array in
  `http-bridge.js`.
