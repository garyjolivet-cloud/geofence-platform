# Chatterbox Studio — local voice-cloning service

Runs `ResembleAI/chatterbox-turbo-ONNX` (350M params, q4-quantized) entirely
on this machine via `onnxruntime` — no cloud API, no per-generation cost.
Voice samples and the voice palette live only in `./voices` on this laptop.
Only the *finished* generated clips get uploaded to the app's cloud Library
by the frontend (`frontend/chatterbox-studio.html`).

## Why local, not a cloud API

This machine (Intel N100, 3.68GB RAM, no discrete GPU) can't run the
standard PyTorch build of Chatterbox — community-reported minimums are
4-8GB RAM. The q4-quantized ONNX export fits comfortably (~1-1.5GB peak),
but expect generation to be slow (tens of seconds to a couple minutes per
line) since there's no GPU acceleration. That's fine for this use case —
time isn't the constraint, RAM headroom is.

## Setup (one-time)

```bash
python -m venv venv
./venv/Scripts/pip install -r requirements.txt
./venv/Scripts/python download_model.py   # downloads ~500MB-1GB of q4 weights
```

## Running

```bash
./venv/Scripts/python server.py
```

Starts on `http://127.0.0.1:8799`. First request after startup will be slow
while the four ONNX sessions load into memory; after that, `/generate`
calls reuse the already-loaded model.

**Important**: `frontend/chatterbox-studio.html` must be opened via the
local Cloudflare dev server — `http://127.0.0.1:8787/chatterbox` (run
`npx wrangler dev` from the repo root) — not the production HTTPS URL.
Browsers block an HTTPS page from calling `http://localhost`, so voice
cloning only works when the Studio page itself is also served locally.

## API

- `GET /health` — liveness + whether the model has finished loading.
- `GET /voices` — list saved voices.
- `POST /voices` (multipart: `name`, `file`) — save a new voice sample.
- `DELETE /voices/{id}` — remove a saved voice.
- `POST /generate` (form: `voiceId`, `text`, `exaggeration?`) — returns a
  WAV file generated in that voice.

## Notes

- Model weights and voice samples are gitignored (`models/`, `voices/`) —
  they're multi-hundred-MB binaries that don't belong in the repo, and
  voices are meant to stay local to this machine anyway.
- Chatterbox can optionally watermark output audio (`perth` package,
  imperceptible, survives MP3 re-encoding) — not enabled here by default
  since this is a fully local/offline workflow; add `perth` to
  requirements.txt and wire it into `ChatterboxEngine.generate()` if
  wanted later.
