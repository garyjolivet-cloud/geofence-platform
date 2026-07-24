"""One-time download of the q4-quantized Chatterbox-Turbo ONNX weights."""
from huggingface_hub import hf_hub_download

MODEL_ID = "ResembleAI/chatterbox-turbo-ONNX"
DTYPE = "q4"


def download_model(name: str, dtype: str = "fp32") -> str:
    filename = f"{name}{'' if dtype == 'fp32' else '_quantized' if dtype == 'q8' else f'_{dtype}'}.onnx"
    graph = hf_hub_download(MODEL_ID, subfolder="onnx", filename=filename, cache_dir="./models")
    hf_hub_download(MODEL_ID, subfolder="onnx", filename=f"{filename}_data", cache_dir="./models")
    return graph


if __name__ == "__main__":
    for component in ["embed_tokens", "language_model", "speech_encoder", "conditional_decoder"]:
        path = download_model(component, dtype=DTYPE)
        print(f"{component}: {path}")

    # Non-ONNX files needed by the tokenizer/preprocessor
    for fname in ["config.json", "generation_config.json", "preprocessor_config.json",
                  "tokenizer.json", "tokenizer_config.json"]:
        path = hf_hub_download(MODEL_ID, filename=fname, cache_dir="./models")
        print(f"{fname}: {path}")

    print("Done.")
