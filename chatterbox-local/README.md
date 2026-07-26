# Chatterbox Studio — local voice service

FastAPI service backing `frontend/chatterbox-studio.html`. The voice palette
(names + Resemble voice UUIDs) lives only in `./voices/voices.json` on this
machine. Only the *finished* generated clips get uploaded to the app's cloud
Library by the frontend.

Every voice runs on **Resemble AI's hosted API** — this service has no local
model of its own, just a thin proxy. Synthesis happens on Resemble's GPU
infrastructure and supports paralinguistic tags (`[laugh]`, `[sigh]`, etc.)
directly in the text. Requires `RESEMBLE_API_TOKEN` in a local `.env` file
(gitignored, never committed) — get a token from an account at
app.resemble.ai.

Voices themselves are **built/cloned on Resemble's website**
(app.resemble.ai), not from this app — the Voice Cloning feature there
requires a Business plan or higher. Once a voice exists in your Resemble
account, copy its voice UUID and register it here via "☁ Add Resemble
voice" in the Studio's Create Voice panel (or `POST /voices/from-resemble`
directly).

This used to also support cloning voices locally via a small ONNX model
(`ResembleAI/chatterbox-turbo-ONNX`) run through `onnxruntime` on this
machine. That path was removed: on this laptop's actual hardware (Intel
N100, 3.68GB total RAM, no discrete GPU) loading the ~700MB model left the
system with essentially no free RAM, and the resulting paging made the
*whole machine* lock up, not just this service — not worth the tradeoff
against Resemble's hosted API being free of that risk entirely.

## Setup (one-time)

```bash
python -m venv venv
./venv/Scripts/pip install -r requirements.txt
```

Create `chatterbox-local/.env`:

```
RESEMBLE_API_TOKEN=your-token-here
```

## Running

```bash
./venv/Scripts/python server.py
```

Starts on `http://127.0.0.1:8799`. Startup is instant — there's no model to
load; every `/generate` call is a proxy to Resemble's hosted API.

**Reaching this service from the browser**: `frontend/chatterbox-studio.html`
talks to whatever `LOCAL_SVC` is set to in that file. For local dev, open the
Studio page via `http://127.0.0.1:8787/chatterbox` (run `npx wrangler dev`
from the repo root) with `LOCAL_SVC` pointed at `http://127.0.0.1:8799`. To
reach it from the production HTTPS page, expose this service over a
Cloudflare Tunnel (`cloudflared tunnel --url http://127.0.0.1:8799`) and
point `LOCAL_SVC` at the tunnel's HTTPS URL — quick tunnels are ephemeral,
so that URL (and `LOCAL_SVC`) needs updating whenever the tunnel restarts.

## API

- `GET /health` — liveness check.
- `GET /voices` — list saved voices.
- `POST /voices/from-resemble` (json: `name`, `resembleVoiceUuid`) —
  register one of the account's existing Resemble AI voices.
- `PATCH /voices/{id}` (json: `name`) — rename a voice.
- `DELETE /voices/{id}` — remove a saved voice.
- `POST /generate` (form: `voiceId`, `text`) — returns a WAV file generated
  in that voice via Resemble's hosted API.

## Notes

- Voice samples (`voices/voices.json`, the only thing stored there now) are
  gitignored — this is a machine-local palette, not shared via the repo.
- `.env` (holding `RESEMBLE_API_TOKEN`) is gitignored via the repo's
  top-level `.env` pattern — never commit it.
