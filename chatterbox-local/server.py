"""Local Chatterbox-Turbo TTS voice-cloning service.

Runs entirely on this machine (no cloud API). Wraps the official
onnxruntime reference pipeline from ResembleAI/chatterbox-turbo-ONNX in a
small FastAPI app so frontend/chatterbox-studio.html (served by the local
`wrangler dev` server) can call it directly at http://127.0.0.1:8799.

Voice samples and the voice palette are stored purely on disk in ./voices —
nothing here touches the Cloudflare Worker or D1. Only the finished
generated clips get uploaded to R2 by the frontend, via the app's existing
/api/audio/:key endpoint.
"""
import io
import json
import time
import uuid
from pathlib import Path

import librosa
import numpy as np
import onnxruntime
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from huggingface_hub import hf_hub_download
from pydantic import BaseModel
from transformers import AutoTokenizer

MODEL_ID = "ResembleAI/chatterbox-turbo-ONNX"
DTYPE = "q4"
SAMPLE_RATE = 24000
START_SPEECH_TOKEN = 6561
STOP_SPEECH_TOKEN = 6562
SILENCE_TOKEN = 4299
NUM_KV_HEADS = 16
HEAD_DIM = 64

BASE_DIR = Path(__file__).parent
MODELS_DIR = BASE_DIR / "models"
VOICES_DIR = BASE_DIR / "voices"
VOICES_DIR.mkdir(exist_ok=True)
VOICES_INDEX = VOICES_DIR / "voices.json"


DEFAULT_VOICE_SETTINGS = {"repetitionPenalty": 1.2, "temperature": 0.0, "seed": None}


def _voice_settings(voice: dict) -> dict:
    """Merges a voice's saved settings over the defaults — old voices
    created before this feature existed have no "settings" key at all and
    keep working unchanged."""
    return {**DEFAULT_VOICE_SETTINGS, **(voice.get("settings") or {})}


def _load_voices_index() -> list[dict]:
    if not VOICES_INDEX.exists():
        return []
    return json.loads(VOICES_INDEX.read_text())


def _save_voices_index(voices: list[dict]) -> None:
    VOICES_INDEX.write_text(json.dumps(voices, indent=2))


def _download_component(name: str, dtype: str = DTYPE) -> str:
    filename = f"{name}{'' if dtype == 'fp32' else '_quantized' if dtype == 'q8' else f'_{dtype}'}.onnx"
    graph = hf_hub_download(MODEL_ID, subfolder="onnx", filename=filename, cache_dir=str(MODELS_DIR))
    hf_hub_download(MODEL_ID, subfolder="onnx", filename=f"{filename}_data", cache_dir=str(MODELS_DIR))
    return graph


class RepetitionPenaltyLogitsProcessor:
    def __init__(self, penalty: float):
        self.penalty = penalty

    def __call__(self, input_ids: np.ndarray, scores: np.ndarray) -> np.ndarray:
        score = np.take_along_axis(scores, input_ids, axis=1)
        score = np.where(score < 0, score * self.penalty, score / self.penalty)
        scores_processed = scores.copy()
        np.put_along_axis(scores_processed, input_ids, score, axis=1)
        return scores_processed


def _sample_token(logits: np.ndarray, temperature: float, rng: "np.random.Generator | None") -> np.ndarray:
    """Greedy (argmax) at temperature<=0 — today's original behavior, the
    most stable/consistent option available. NOTE: this is not bit-exact
    reproducible run-to-run on this hardware — verified empirically that
    even single-threaded execution with graph optimizations disabled still
    produces different output across identical calls (root cause is deeper
    than thread-order non-determinism, likely a genuinely non-deterministic
    CPU kernel somewhere in this ONNX build; not worth chasing further).
    Above 0, softmax-with-temperature + multinomial sampling via the given
    Generator — the only real "expressiveness" knob this pipeline exposes,
    since the ONNX graphs have no exaggeration/cfg_weight input to condition
    on (confirmed by inspecting all four graphs' actual input signatures —
    that concept doesn't survive Turbo's distillation). The seed makes the
    *sampling step itself* reproducible, but since the underlying logits
    already vary slightly run-to-run, it narrows variation rather than
    guaranteeing an identical result. Assumes batch_size=1, which is all
    this service ever does."""
    if temperature <= 0 or rng is None:
        return np.argmax(logits, axis=-1, keepdims=True).astype(np.int64)
    scaled = logits[0] / temperature
    scaled = scaled - scaled.max()
    probs = np.exp(scaled)
    probs /= probs.sum()
    choice = rng.choice(probs.shape[-1], p=probs)
    return np.array([[choice]], dtype=np.int64)


class ChatterboxEngine:
    """Loads all four ONNX components once and keeps them resident."""

    def __init__(self):
        print("Loading Chatterbox-Turbo ONNX sessions (this can take a while on first run)...")
        t0 = time.time()
        self.tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, cache_dir=str(MODELS_DIR))
        self.speech_encoder = onnxruntime.InferenceSession(_download_component("speech_encoder"))
        self.embed_tokens = onnxruntime.InferenceSession(_download_component("embed_tokens"))
        self.language_model = onnxruntime.InferenceSession(_download_component("language_model"))
        self.cond_decoder = onnxruntime.InferenceSession(_download_component("conditional_decoder"))
        print(f"Chatterbox-Turbo ready in {time.time() - t0:.1f}s")

    def generate(self, text: str, reference_wav_path: str,
                 max_new_tokens: int = 1024, repetition_penalty: float = 1.2,
                 temperature: float = 0.0, seed: "int | None" = None,
                 progress_cb=None) -> tuple[np.ndarray, int]:
        audio_values, _ = librosa.load(reference_wav_path, sr=SAMPLE_RATE)
        audio_values = audio_values[np.newaxis, :].astype(np.float32)

        input_ids = self.tokenizer(text, return_tensors="np")["input_ids"].astype(np.int64)

        rep_penalty = RepetitionPenaltyLogitsProcessor(penalty=repetition_penalty)
        rng = np.random.default_rng(seed) if temperature > 0 else None
        generate_tokens = np.array([[START_SPEECH_TOKEN]], dtype=np.int64)

        attention_mask = None
        position_ids = None
        past_key_values = None
        prompt_token = speaker_embeddings = speaker_features = None

        for i in range(max_new_tokens):
            inputs_embeds = self.embed_tokens.run(None, {"input_ids": input_ids})[0]

            if i == 0:
                cond_emb, prompt_token, speaker_embeddings, speaker_features = self.speech_encoder.run(
                    None, {"audio_values": audio_values}
                )
                inputs_embeds = np.concatenate((cond_emb, inputs_embeds), axis=1)

                batch_size, seq_len, _ = inputs_embeds.shape
                past_key_values = {
                    inp.name: np.zeros(
                        [batch_size, NUM_KV_HEADS, 0, HEAD_DIM],
                        dtype=np.float16 if inp.type == "tensor(float16)" else np.float32,
                    )
                    for inp in self.language_model.get_inputs()
                    if "past_key_values" in inp.name
                }
                attention_mask = np.ones((batch_size, seq_len), dtype=np.int64)
                position_ids = np.arange(seq_len, dtype=np.int64).reshape(1, -1).repeat(batch_size, axis=0)

            logits, *present_key_values = self.language_model.run(
                None,
                dict(
                    inputs_embeds=inputs_embeds,
                    attention_mask=attention_mask,
                    position_ids=position_ids,
                    **past_key_values,
                ),
            )

            logits = logits[:, -1, :]
            next_token_logits = rep_penalty(generate_tokens, logits)
            input_ids = _sample_token(next_token_logits, temperature, rng)
            generate_tokens = np.concatenate((generate_tokens, input_ids), axis=-1)
            if progress_cb is not None:
                progress_cb(i + 1, max_new_tokens)
            if (input_ids.flatten() == STOP_SPEECH_TOKEN).all():
                break

            attention_mask = np.concatenate([attention_mask, np.ones((batch_size, 1), dtype=np.int64)], axis=1)
            position_ids = position_ids[:, -1:] + 1
            for j, key in enumerate(past_key_values):
                past_key_values[key] = present_key_values[j]

        speech_tokens = generate_tokens[:, 1:-1]
        silence_tokens = np.full((speech_tokens.shape[0], 3), SILENCE_TOKEN, dtype=np.int64)
        speech_tokens = np.concatenate([prompt_token, speech_tokens, silence_tokens], axis=1)

        wav = self.cond_decoder.run(
            None,
            dict(
                speech_tokens=speech_tokens,
                speaker_embeddings=speaker_embeddings,
                speaker_features=speaker_features,
            ),
        )[0].squeeze(axis=0)

        return wav, SAMPLE_RATE


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

engine: ChatterboxEngine | None = None

# In-memory generation-progress tracking, keyed by a client-chosen jobId —
# the frontend polls GET /progress/{jobId} while the blocking POST /generate
# call for that same jobId is in flight. FastAPI runs sync `def` endpoints
# (like generate() below) in a thread pool, so polling requests are served
# concurrently rather than queued behind the inference call.
_progress: dict[str, dict] = {}
_PROGRESS_TTL_S = 300  # long enough for the frontend's slowest realistic poll gap


def _prune_progress():
    """Evicts finished job entries older than the TTL so this dict doesn't
    grow unbounded over a long session — called once per /generate call,
    which is plenty given jobs are minutes apart at best on this hardware."""
    now = time.time()
    stale = [jid for jid, p in _progress.items()
             if p.get("done") and now - p.get("startedAt", now) > _PROGRESS_TTL_S]
    for jid in stale:
        del _progress[jid]


@app.on_event("startup")
def _load_engine():
    global engine
    engine = ChatterboxEngine()


@app.get("/health")
def health():
    return {"status": "ok", "engine_loaded": engine is not None}


@app.get("/progress/{job_id}")
def get_progress(job_id: str):
    return _progress.get(job_id, {"step": 0, "total": 0, "done": False})


@app.get("/voices")
def list_voices():
    return _load_voices_index()


@app.post("/voices")
async def create_voice(name: str = Form(...), file: UploadFile = File(...)):
    voice_id = uuid.uuid4().hex[:12]
    ext = Path(file.filename or "sample.wav").suffix or ".wav"
    dest = VOICES_DIR / f"{voice_id}{ext}"
    dest.write_bytes(await file.read())

    voices = _load_voices_index()
    voices.append({"id": voice_id, "name": name, "file": dest.name})
    _save_voices_index(voices)
    return {"id": voice_id, "name": name}


@app.delete("/voices/{voice_id}")
def delete_voice(voice_id: str):
    voices = _load_voices_index()
    match = next((v for v in voices if v["id"] == voice_id), None)
    if not match:
        raise HTTPException(404, "voice not found")
    voice_file = VOICES_DIR / match["file"]
    if voice_file.exists():
        voice_file.unlink()
    voices = [v for v in voices if v["id"] != voice_id]
    _save_voices_index(voices)
    return {"deleted": voice_id}


class VoiceSettingsUpdate(BaseModel):
    repetitionPenalty: "float | None" = None
    temperature: "float | None" = None
    seed: "int | None" = None


@app.put("/voices/{voice_id}/settings")
def update_voice_settings(voice_id: str, body: VoiceSettingsUpdate):
    voices = _load_voices_index()
    match = next((v for v in voices if v["id"] == voice_id), None)
    if not match:
        raise HTTPException(404, "voice not found")

    current = _voice_settings(match)
    updates = body.model_dump(exclude_unset=True)
    match["settings"] = {**current, **updates}
    _save_voices_index(voices)
    return match["settings"]


@app.post("/generate")
def generate(voiceId: str = Form(...), text: str = Form(...), jobId: str = Form(None)):
    if engine is None:
        raise HTTPException(503, "engine still loading")

    voices = _load_voices_index()
    match = next((v for v in voices if v["id"] == voiceId), None)
    if not match:
        raise HTTPException(404, "voice not found")

    _prune_progress()

    reference_path = VOICES_DIR / match["file"]
    settings = _voice_settings(match)
    t0 = time.time()

    def on_progress(step, total):
        if jobId:
            _progress[jobId] = {"step": step, "total": total, "done": False, "startedAt": t0}

    try:
        wav, sr = engine.generate(text=text, reference_wav_path=str(reference_path),
                                   repetition_penalty=settings["repetitionPenalty"],
                                   temperature=settings["temperature"], seed=settings["seed"],
                                   progress_cb=on_progress)
    finally:
        if jobId:
            _progress.setdefault(jobId, {"step": 0, "total": 1024, "startedAt": t0})["done"] = True

    elapsed = time.time() - t0
    print(f"Generated {len(wav) / sr:.1f}s of audio in {elapsed:.1f}s ({elapsed / max(len(wav) / sr, 0.01):.2f}x realtime)")

    buf = io.BytesIO()
    sf.write(buf, wav, sr, format="WAV")
    return Response(content=buf.getvalue(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8799)
