# Chatterbox Studio — local voice-cloning service

FastAPI service backing `frontend/chatterbox-studio.html`. Voice samples and
the voice palette live only in `./voices` on this machine. Only the
*finished* generated clips get uploaded to the app's cloud Library by the
frontend.

Each voice uses one of two backends, picked per-voice automatically:

- **Local ONNX** (`ResembleAI/chatterbox-turbo-ONNX`, 350M params,
  q4-quantized) — voices with a local reference audio file. Runs entirely on
  this machine via `onnxruntime`, no cloud API, no per-generation cost, but
  slow on CPU-only hardware (this laptop: Intel N100, 3.68GB RAM, no
  discrete GPU) and can't honor paralinguistic tags or exaggeration control
  — that capability didn't survive the ONNX distillation.
- **Resemble AI hosted API** — voices with a `resembleVoiceUuid` instead of
  a local file. Runs on Resemble's GPU infrastructure; dramatically faster
  and supports paralinguistic tags (`[laugh]`, `[sigh]`, etc.) directly in
  the text. Requires `RESEMBLE_API_TOKEN` in a local `.env` file (gitignored,
  never committed) — get a token from an account at app.resemble.ai.

## Setup (one-time)

```bash
python -m venv venv
./venv/Scripts/pip install -r requirements.txt
```

No manual model download step — the local ONNX engine downloads and loads
itself automatically (and lazily, only once actually needed) the first time
a local-reference-file voice is generated. If you're only using
Resemble-backed voices, nothing local ever gets downloaded at all.

If using the Resemble AI backend, create `chatterbox-local/.env`:

```
RESEMBLE_API_TOKEN=your-token-here
```

## Running

```bash
./venv/Scripts/python server.py
```

Starts on `http://127.0.0.1:8799`. Startup is instant — the local ONNX
engine only loads (and downloads its ~700MB of weights, if not already
cached) on the first `/generate` call for a local-reference-file voice.

**Reaching this service from the browser**: `frontend/chatterbox-studio.html`
talks to whatever `LOCAL_SVC` is set to in that file. For local dev, open the
Studio page via `http://127.0.0.1:8787/chatterbox` (run `npx wrangler dev`
from the repo root) with `LOCAL_SVC` pointed at `http://127.0.0.1:8799`. To
reach it from the production HTTPS page, expose this service over a
Cloudflare Tunnel (`cloudflared tunnel --url http://127.0.0.1:8799`) and
point `LOCAL_SVC` at the tunnel's HTTPS URL — quick tunnels are ephemeral,
so that URL (and `LOCAL_SVC`) needs updating whenever the tunnel restarts.

## API

- `GET /health` — liveness + whether the local ONNX engine has been loaded
  yet (irrelevant to Resemble-backed voices, which need no local engine).
- `GET /voices` — list saved voices.
- `POST /voices` (multipart: `name`, `file`) — save a new voice from an
  uploaded audio sample (local-engine backend).
- `POST /voices/from-library` (json: `name`, `url`) — save a new voice from
  an existing clip already in the app's Library (local-engine backend).
- `POST /voices/from-resemble` (json: `name`, `resembleVoiceUuid`) —
  register one of the account's existing Resemble AI voices.
- `PATCH /voices/{id}` (json: `name`) — rename a voice.
- `PUT /voices/{id}/settings` (json: `repetitionPenalty?`, `temperature?`,
  `seed?`) — local-engine-only; no-op for Resemble-backed voices.
- `DELETE /voices/{id}` — remove a saved voice.
- `POST /generate` (form: `voiceId`, `text`, `jobId?`, `repetitionPenalty?`,
  `temperature?`, `seed?`, `overrideSeed?`) — returns a WAV file generated
  in that voice. The `repetitionPenalty`/`temperature`/`seed`/`overrideSeed`
  fields only apply to local-engine voices.
- `GET /progress/{jobId}` — per-token progress for an in-flight local-engine
  generation; always reads as complete-on-finish for Resemble generations
  (no per-token progress exists for a single hosted API call).

## Notes

- Model weights and voice samples are gitignored (`models/`, `voices/`) —
  multi-hundred-MB binaries that don't belong in the repo.
- `.env` (holding `RESEMBLE_API_TOKEN`) is gitignored via the repo's
  top-level `.env` pattern — never commit it.
- Chatterbox can optionally watermark local-engine output audio (`perth`
  package, imperceptible, survives MP3 re-encoding) — not enabled here by
  default; add `perth` to requirements.txt and wire it into
  `ChatterboxEngine.generate()` if wanted later.
