"""One-off evaluation script for the FULL (non-Turbo) Chatterbox ONNX export
(onnx-community/chatterbox-ONNX) — checks whether it fits in RAM and how
fast it runs on this machine, and exercises the `exaggeration` control that
Turbo's distillation dropped. Not wired into server.py; this is purely a
try-it-and-see test per the reference inference code in that repo's README.

Run: venv/Scripts/python try_full_model.py
"""
import time

t_start = time.time()
import numpy as np
import onnxruntime
from huggingface_hub import hf_hub_download
from transformers import AutoTokenizer
import librosa
import soundfile as sf

MODEL_ID = "onnx-community/chatterbox-ONNX"
S3GEN_SR = 24000
START_SPEECH_TOKEN = 6561
STOP_SPEECH_TOKEN = 6562

MODELS_DIR = "./models"


class RepetitionPenaltyLogitsProcessor:
    def __init__(self, penalty: float):
        self.penalty = penalty

    def __call__(self, input_ids, scores):
        score = np.take_along_axis(scores, input_ids, axis=1)
        score = np.where(score < 0, score * self.penalty, score / self.penalty)
        scores_processed = scores.copy()
        np.put_along_axis(scores_processed, input_ids, score, axis=1)
        return scores_processed


def dl(filename, dtype_suffix=""):
    name = f"{filename}{dtype_suffix}.onnx"
    path = hf_hub_download(MODEL_ID, subfolder="onnx", filename=name, cache_dir=MODELS_DIR)
    hf_hub_download(MODEL_ID, subfolder="onnx", filename=f"{name}_data", cache_dir=MODELS_DIR)
    return path


def main():
    print(f"[{time.time()-t_start:6.1f}s] downloading components (best available quant: language_model q4, "
          f"speech_encoder/conditional_decoder fp32 — no smaller quant published for those two)...")
    speech_encoder_path = dl("speech_encoder")
    embed_tokens_path = dl("embed_tokens")
    language_model_path = dl("language_model", "_q4")
    conditional_decoder_path = dl("conditional_decoder")

    print(f"[{time.time()-t_start:6.1f}s] downloads done, loading ONNX sessions...")
    t_load = time.time()
    speech_encoder_session = onnxruntime.InferenceSession(speech_encoder_path)
    embed_tokens_session = onnxruntime.InferenceSession(embed_tokens_path)
    llama_session = onnxruntime.InferenceSession(language_model_path)
    cond_decoder_session = onnxruntime.InferenceSession(conditional_decoder_path)
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, cache_dir=MODELS_DIR)
    print(f"[{time.time()-t_start:6.1f}s] sessions loaded in {time.time()-t_load:.1f}s")

    default_voice = hf_hub_download(MODEL_ID, filename="default_voice.wav", cache_dir=MODELS_DIR)

    text = "The Lord of the Rings is the greatest work of literature ever written, and I will not hear otherwise."
    exaggeration = 0.7  # dramatic setting per the model card's own suggestion for expressive speech
    max_new_tokens = 256

    print(f"[{time.time()-t_start:6.1f}s] generating (exaggeration={exaggeration})...")
    t_gen = time.time()

    audio_values, _ = librosa.load(default_voice, sr=S3GEN_SR)
    audio_values = audio_values[np.newaxis, :].astype(np.float32)

    input_ids = tokenizer(text, return_tensors="np")["input_ids"].astype(np.int64)
    position_ids = np.where(
        input_ids >= START_SPEECH_TOKEN, 0,
        np.arange(input_ids.shape[1])[np.newaxis, :] - 1,
    )
    ort_embed_inputs = {
        "input_ids": input_ids,
        "position_ids": position_ids,
        "exaggeration": np.array([exaggeration], dtype=np.float32),
    }

    rep_penalty = RepetitionPenaltyLogitsProcessor(penalty=1.2)
    num_hidden_layers, num_key_value_heads, head_dim = 30, 16, 64
    generate_tokens = np.array([[START_SPEECH_TOKEN]], dtype=np.int64)

    step_times = []
    for i in range(max_new_tokens):
        t_step = time.time()
        inputs_embeds = embed_tokens_session.run(None, ort_embed_inputs)[0]
        if i == 0:
            cond_emb, prompt_token, ref_x_vector, prompt_feat = speech_encoder_session.run(
                None, {"audio_values": audio_values}
            )
            inputs_embeds = np.concatenate((cond_emb, inputs_embeds), axis=1)
            batch_size, seq_len, _ = inputs_embeds.shape
            past_key_values = {
                f"past_key_values.{layer}.{kv}": np.zeros(
                    [batch_size, num_key_value_heads, 0, head_dim], dtype=np.float32
                )
                for layer in range(num_hidden_layers)
                for kv in ("key", "value")
            }
            attention_mask = np.ones((batch_size, seq_len), dtype=np.int64)

        logits, *present_key_values = llama_session.run(
            None, dict(inputs_embeds=inputs_embeds, attention_mask=attention_mask, **past_key_values)
        )
        logits = logits[:, -1, :]
        next_token_logits = rep_penalty(generate_tokens, logits)
        next_token = np.argmax(next_token_logits, axis=-1, keepdims=True).astype(np.int64)
        generate_tokens = np.concatenate((generate_tokens, next_token), axis=-1)
        step_times.append(time.time() - t_step)
        if i < 3 or i % 20 == 0:
            print(f"    step {i:3d}  {step_times[-1]*1000:6.1f} ms/token")
        if (next_token.flatten() == STOP_SPEECH_TOKEN).all():
            break

        position_ids = np.full((input_ids.shape[0], 1), i + 1, dtype=np.int64)
        ort_embed_inputs["input_ids"] = next_token
        ort_embed_inputs["position_ids"] = position_ids
        attention_mask = np.concatenate([attention_mask, np.ones((batch_size, 1), dtype=np.int64)], axis=1)
        for j, key in enumerate(past_key_values):
            past_key_values[key] = present_key_values[j]

    speech_tokens = generate_tokens[:, 1:-1]
    speech_tokens = np.concatenate([prompt_token, speech_tokens], axis=1)

    t_decode = time.time()
    wav = cond_decoder_session.run(
        None,
        {"speech_tokens": speech_tokens, "speaker_embeddings": ref_x_vector, "speaker_features": prompt_feat},
    )[0]
    wav = np.squeeze(wav, axis=0)
    decode_s = time.time() - t_decode

    gen_s = time.time() - t_gen
    audio_s = len(wav) / S3GEN_SR
    sf.write("try_full_output.wav", wav, S3GEN_SR)

    print(f"\n[{time.time()-t_start:6.1f}s] DONE")
    print(f"  tokens generated: {len(step_times)}  (avg {1000*sum(step_times)/len(step_times):.1f} ms/token, "
          f"median {1000*sorted(step_times)[len(step_times)//2]:.1f} ms/token)")
    print(f"  cond_decoder step: {decode_s:.1f}s")
    print(f"  audio length: {audio_s:.1f}s, generation wall time: {gen_s:.1f}s -> {gen_s/max(audio_s,0.01):.2f}x realtime")
    print(f"  output written to try_full_output.wav")


if __name__ == "__main__":
    main()
