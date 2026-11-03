import json

from favvault_worker import local_models as lm


def _mk(tmp, files, cfg):
    tmp.mkdir(parents=True, exist_ok=True)
    (tmp / "config.json").write_text(json.dumps(cfg))
    for f in files:
        (tmp / f).write_bytes(b"x")
    return tmp


def test_formats(tmp_path):
    assert lm.model_format(_mk(tmp_path / "a", ["model.safetensors"], {"model_type": "whisper", "num_mel_bins": 80})) == "hf"
    assert lm.model_format(_mk(tmp_path / "b", ["weights.npz"], {"n_mels": 80})) == "mlx"
    assert lm.model_format(_mk(tmp_path / "c", ["pytorch_model.bin"], {"model_type": "whisper"})) == "hf-bin"
    assert lm.model_format(_mk(tmp_path / "d", ["model.bin"], {})) == "ct2"
    assert lm.model_format(tmp_path / "missing") == ""


def test_remap_names():
    r = lm._remap
    assert r("model.encoder.layers.0.self_attn.q_proj.weight") == "encoder.blocks.0.attn.query.weight"
    assert r("model.encoder.layers.0.self_attn_layer_norm.bias") == "encoder.blocks.0.attn_ln.bias"
    assert r("model.decoder.layers.1.encoder_attn.k_proj.weight") == "decoder.blocks.1.cross_attn.key.weight"
    assert r("model.decoder.layers.1.encoder_attn_layer_norm.weight") == "decoder.blocks.1.cross_attn_ln.weight"
    assert r("model.decoder.layers.1.final_layer_norm.weight") == "decoder.blocks.1.mlp_ln.weight"
    assert r("model.decoder.layers.1.fc2.bias") == "decoder.blocks.1.mlp2.bias"
    assert r("model.decoder.embed_tokens.weight") == "decoder.token_embedding.weight"
    assert r("model.decoder.embed_positions.weight") == "decoder.positional_embedding"
    assert r("model.encoder.layer_norm.weight") == "encoder.ln_post.weight"
    assert r("model.decoder.layer_norm.bias") == "decoder.ln.bias"
    assert r("model.encoder.embed_positions.weight") is None
    assert r("proj_out.weight") is None


def test_converted_dir_named_after_repo(tmp_path):
    src = tmp_path / "hub" / "models--openai--whisper-base" / "snapshots" / "abc"
    assert lm.converted_dir(src, tmp_path / "hub") == tmp_path / "dkv-mlx" / "openai--whisper-base"
