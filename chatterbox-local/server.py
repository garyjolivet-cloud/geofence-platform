"""Local Chatterbox Studio voice service.

Thin FastAPI wrapper around Resemble AI's hosted Chatterbox Turbo API so
frontend/chatterbox-studio.html (served by the local `wrangler dev` server)
can call it directly at http://127.0.0.1:8799. All synthesis runs on
Resemble's GPU infrastructure — nothing here runs a local model, so this
service has no meaningful RAM/CPU footprint of its own.

Voice samples and the voice palette are stored purely on disk in ./voices —
nothing here touches the Cloudflare Worker or D1. Only the finished
generated clips get uploaded to R2 by the frontend, via the app's existing
/api/audio/:key endpoint.
"""
import base64
import io
import json
import os
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf
from dotenv import load_dotenv
from fastapi import FastAPI, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

load_dotenv()

RESEMBLE_API_TOKEN = os.environ.get("RESEMBLE_API_TOKEN")
RESEMBLE_SYNTHESIZE_URL = "https://f.cluster.resemble.ai/synthesize"

BASE_DIR = Path(__file__).parent
VOICES_DIR = BASE_DIR / "voices"
VOICES_DIR.mkdir(exist_ok=True)
VOICES_INDEX = VOICES_DIR / "voices.json"


def _load_voices_index() -> list[dict]:
    if not VOICES_INDEX.exists():
        return []
    return json.loads(VOICES_INDEX.read_text())


def _save_voices_index(voices: list[dict]) -> None:
    VOICES_INDEX.write_text(json.dumps(voices, indent=2))


def _synthesize_resemble(text: str, voice_uuid: str, use_hd: bool = False) -> tuple[np.ndarray, int]:
    """Calls Resemble AI's hosted (GPU) Chatterbox Turbo. Supports
    paralinguistic tags ([laugh], [sigh], [gasp], [cough], [whisper],
    [breath]) directly in `text`."""
    if not RESEMBLE_API_TOKEN:
        raise HTTPException(500, "RESEMBLE_API_TOKEN not set — add it to chatterbox-local/.env")

    body = json.dumps({
        "voice_uuid": voice_uuid,
        "data": text,
        "output_format": "wav",
        "use_hd": use_hd,
    }).encode()
    req = urllib.request.Request(
        RESEMBLE_SYNTHESIZE_URL, data=body, method="POST",
        headers={
            "Authorization": f"Bearer {RESEMBLE_API_TOKEN}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise HTTPException(502, f"Resemble API error: {e.read().decode(errors='replace')}")

    if not result.get("success"):
        raise HTTPException(502, f"Resemble synthesis failed: {result.get('message') or result}")

    wav_bytes = base64.b64decode(result["audio_content"])
    wav, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32")
    return wav, sr


app = FastAPI(title="Chatterbox Studio local service")
app.add_middleware(
    CORSMiddleware,
    # Local dev origins plus the production site — the production page
    # reaches this local service through a Cloudflare Tunnel (see
    # README.md), so it needs to be an allowed CORS origin too, not just
    # localhost.
    allow_origins=[
        "http://127.0.0.1:8787",
        "http://localhost:8787",
        "https://geofence-platform.gary-jolivet.workers.dev",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/voices")
def list_voices():
    return _load_voices_index()


class VoiceFromResemble(BaseModel):
    name: str
    resembleVoiceUuid: str


@app.post("/voices/from-resemble")
def create_voice_from_resemble(body: VoiceFromResemble):
    # Registers one of the account's existing Resemble AI voices (built at
    # app.resemble.ai) as a Studio voice. /generate always routes to their
    # hosted API using this UUID.
    voice_id = uuid.uuid4().hex[:12]
    voices = _load_voices_index()
    entry = {"id": voice_id, "name": body.name, "resembleVoiceUuid": body.resembleVoiceUuid}
    voices.append(entry)
    _save_voices_index(voices)
    return {"id": entry["id"], "name": entry["name"]}


class VoiceRename(BaseModel):
    name: str


@app.patch("/voices/{voice_id}")
def rename_voice(voice_id: str, body: VoiceRename):
    voices = _load_voices_index()
    match = next((v for v in voices if v["id"] == voice_id), None)
    if not match:
        raise HTTPException(404, "voice not found")
    match["name"] = body.name
    _save_voices_index(voices)
    return {"id": voice_id, "name": match["name"]}


@app.delete("/voices/{voice_id}")
def delete_voice(voice_id: str):
    voices = _load_voices_index()
    match = next((v for v in voices if v["id"] == voice_id), None)
    if not match:
        raise HTTPException(404, "voice not found")
    if match.get("file"):  # leftover from a voice created before local cloning was removed
        voice_file = VOICES_DIR / match["file"]
        if voice_file.exists():
            voice_file.unlink()
    voices = [v for v in voices if v["id"] != voice_id]
    _save_voices_index(voices)
    return {"deleted": voice_id}


@app.post("/generate")
def generate(voiceId: str = Form(...), text: str = Form(...)):
    voices = _load_voices_index()
    match = next((v for v in voices if v["id"] == voiceId), None)
    if not match:
        raise HTTPException(404, "voice not found")

    resemble_uuid = match.get("resembleVoiceUuid")
    if not resemble_uuid:
        raise HTTPException(422, "voice has no Resemble voice ID — local voice cloning has been "
                                  "removed, re-add this voice via /voices/from-resemble")

    t0 = time.time()
    wav, sr = _synthesize_resemble(text=text, voice_uuid=resemble_uuid)
    elapsed = time.time() - t0
    print(f"Generated {len(wav) / sr:.1f}s of audio in {elapsed:.1f}s ({elapsed / max(len(wav) / sr, 0.01):.2f}x realtime)")

    buf = io.BytesIO()
    sf.write(buf, wav, sr, format="WAV")
    return Response(content=buf.getvalue(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8799)
