"""Local Whisper models the user already has (for example `models--openai--whisper-base` in the
Hugging Face cache, downloaded by some other tool).

mlx-whisper only reads its own layout (config.json with n_mels/... + weights.safetensors|npz).
A Hugging Face *transformers* Whisper checkpoint (config.json with num_mel_bins/d_model +
model.safetensors) is converted once, without PyTorch: mlx reads safetensors directly, the
tensor names are mapped to mlx-whisper's, conv kernels are transposed, and the result is saved
as float16 next to the Hugging Face cache (<cache>/../dkv-mlx/<name>). Later runs reuse it.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from .events import emit, log

DIMS_FROM_HF = {
    "n_mels": "num_mel_bins",
    "n_audio_ctx": "max_source_positions",
    "n_audio_state": "d_model",
    "n_audio_head": "encoder_attention_heads",
    "n_audio_layer": "encoder_layers",
    "n_vocab": "vocab_size",
    "n_text_ctx": "max_target_positions",
    "n_text_state": "d_model",
    "n_text_head": "decoder_attention_heads",
    "n_text_layer": "decoder_layers",
}


def _config(folder: Path) -> dict | None:
    try:
        return json.loads((folder / "config.json").read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None


def model_format(folder: Path) -> str:
    """'mlx' | 'hf' | 'hf-bin' (transformers, only pytorch_model.bin) | 'ct2' | ''"""
    folder = Path(folder)
    cfg = _config(folder)
    if cfg is None:
        return ""
    if "n_mels" in cfg and ((folder / "weights.safetensors").exists() or (folder / "weights.npz").exists()):
        return "mlx"
    if cfg.get("model_type") == "whisper" or "num_mel_bins" in cfg:
        if (folder / "model.safetensors").exists():
            return "hf"
        if (folder / "pytorch_model.bin").exists():
            return "hf-bin"
    if (folder / "model.bin").exists():
        return "ct2"
    return ""


def _remap(k: str) -> str | None:
    if k.startswith("model."):
        k = k[len("model."):]
    if k.startswith("proj_out") or k == "encoder.embed_positions.weight":
        return None  # tied to token_embedding / mlx-whisper computes encoder sinusoids itself
    k = k.replace(".layers.", ".blocks.")
    # layer norms first, so the attention renames below don't eat them
    k = k.replace(".self_attn_layer_norm.", ".attn_ln.")
    k = k.replace(".encoder_attn_layer_norm.", ".cross_attn_ln.")
    k = k.replace(".final_layer_norm.", ".mlp_ln.")
    k = k.replace(".self_attn.", ".attn.")
    k = k.replace(".encoder_attn.", ".cross_attn.")
    k = k.replace(".q_proj.", ".query.").replace(".k_proj.", ".key.").replace(".v_proj.", ".value.")
    k = k.replace(".out_proj.", ".out.")
    k = k.replace(".fc1.", ".mlp1.").replace(".fc2.", ".mlp2.")
    k = k.replace("decoder.embed_tokens.weight", "decoder.token_embedding.weight")
    k = k.replace("decoder.embed_positions.weight", "decoder.positional_embedding")
    k = k.replace("encoder.layer_norm.", "encoder.ln_post.")
    k = k.replace("decoder.layer_norm.", "decoder.ln.")
    return k


def converted_dir(src: Path, cache: Path) -> Path:
    name = src.name
    # snapshot folders are hashes: name the output after models--org--repo instead
    for p in [src, *src.parents]:
        if p.name.startswith("models--"):
            name = p.name[len("models--"):]
            break
    return cache.parent / "dkv-mlx" / name


def convert_hf_to_mlx(src: Path, dst: Path) -> Path:
    import mlx.core as mx  # type: ignore

    cfg = _config(src) or {}
    missing = [hf for hf in DIMS_FROM_HF.values() if hf not in cfg]
    if missing:
        raise RuntimeError(f"不是标准的 Whisper 模型（config.json 缺少 {', '.join(missing)}）")
    dims = {k: int(cfg[v]) for k, v in DIMS_FROM_HF.items()}
    emit("stage", stage="model_convert", model=str(src))
    log(f"converting local Whisper model {src} -> {dst}")
    weights = mx.load(str(src / "model.safetensors"))
    out = {}
    for k, v in weights.items():
        nk = _remap(k)
        if nk is None:
            continue
        if nk.endswith("conv1.weight") or nk.endswith("conv2.weight"):
            v = v.transpose(0, 2, 1)  # torch (out, in, k) -> mlx (out, k, in)
        out[nk] = v.astype(mx.float16)
    tmp = dst.with_name(dst.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True, exist_ok=True)
    mx.save_safetensors(str(tmp / "weights.safetensors"), out)
    (tmp / "config.json").write_text(json.dumps({**dims, "model_type": "whisper"}, indent=2), encoding="utf-8")
    shutil.rmtree(dst, ignore_errors=True)
    tmp.rename(dst)
    return dst


def resolve_for_mlx(folder: str | Path, cache: Path) -> str:
    """Return a folder mlx-whisper can load, converting a transformers checkpoint once."""
    src = Path(folder).expanduser()
    fmt = model_format(src)
    if fmt == "mlx":
        return str(src)
    if fmt == "hf":
        dst = converted_dir(src, cache)
        if model_format(dst) == "mlx":
            return str(dst)
        return str(convert_hf_to_mlx(src, dst))
    if fmt == "hf-bin":
        raise RuntimeError("这个 Whisper 模型只有 pytorch_model.bin，没有 model.safetensors，无法转换（可在 Hugging Face 重新下载 safetensors 版）")
    if fmt == "ct2":
        raise RuntimeError("这是 faster-whisper（CTranslate2）格式的模型，M 芯片版用不了，请选 MLX 或 Hugging Face 原版模型")
    raise RuntimeError(f"无法识别的模型文件夹：{src}")
