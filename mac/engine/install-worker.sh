#!/usr/bin/env bash
# Installs FavVault's processing components into ~/Library/Application Support/FavVault
# (or $FAVVAULT_HOME when set, e.g. by the 抖音知识库 Electron app).
# No Homebrew needed: uv is installed into the app folder, it fetches Python itself,
# and ffmpeg comes from the imageio-ffmpeg wheel.
#
# Usage: install-worker.sh [worker_dir] [extra]
#   worker_dir  path to the worker package (default: ../worker next to this script)
#   extra       "" (base) | "sensevoice" (SenseVoice via sherpa-onnx, CPU) | "mlx" (Whisper on Apple Silicon)
#               | "cpu" (faster-whisper) | a comma list such as "mlx,sensevoice"
# Output: lines "PROGRESS <0-100> <message>" for the app, then "DONE" or "FAILED <message>".
set -uo pipefail

HOME_DIR="${FAVVAULT_HOME:-$HOME/Library/Application Support/FavVault}"  # other apps may install elsewhere
WORKER_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)/worker}"
EXTRA="${2:-}"
BIN_DIR="$HOME_DIR/bin"
VENV="$HOME_DIR/venv"
export PATH="$BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export UV_PYTHON_INSTALL_DIR="$HOME_DIR/python"
export UV_CACHE_DIR="$HOME_DIR/cache/uv"

fail() { echo "FAILED $*"; exit 1; }
mkdir -p "$BIN_DIR" || fail "无法创建 $HOME_DIR"

echo "PROGRESS 5 准备安装工具"
# 国内网络访问 GitHub/PyPI 很慢：先测一下，慢就全部走国内镜像
CN=0
if ! curl -fsS -o /dev/null -m 6 https://github.com 2>/dev/null; then CN=1; fi
if [[ "$CN" == 1 ]]; then
  export UV_PYTHON_INSTALL_MIRROR="https://registry.npmmirror.com/-/binary/python-build-standalone"
  export UV_DEFAULT_INDEX="https://pypi.tuna.tsinghua.edu.cn/simple"
  export UV_INDEX_URL="$UV_DEFAULT_INDEX"
  export UV_HTTP_TIMEOUT=120
fi
install_uv_from_mirror() {
  local idx="https://pypi.tuna.tsinghua.edu.cn/simple/uv/" whl tmp
  whl="$(curl -fsSL -m 30 "$idx" | grep -oE 'href="[^"]*uv-[0-9.]+-py3-none-macosx_[0-9_]+_arm64\.whl[^"]*"' | tail -1 | sed -E 's/^href="//; s/"$//; s/#.*$//')" || return 1
  [[ -n "$whl" ]] || return 1
  if [[ "$whl" != http* ]]; then whl="${whl#/}"; while [[ "$whl" == ../* ]]; do whl="${whl#../}"; done; whl="https://pypi.tuna.tsinghua.edu.cn/$whl"; fi
  tmp="$(mktemp -d)" || return 1
  curl -fsSL -m 300 -o "$tmp/uv.whl" "$whl" || return 1
  (cd "$tmp" && unzip -q -o uv.whl 'uv-*.data/scripts/uv') || return 1
  cp "$tmp"/uv-*.data/scripts/uv "$BIN_DIR/uv" && chmod +x "$BIN_DIR/uv"
}
if ! command -v uv >/dev/null 2>&1; then
  echo "PROGRESS 10 下载 uv"
  if [[ "$CN" == 1 ]]; then
    install_uv_from_mirror || curl -LsSf -m 300 https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$BIN_DIR" UV_NO_MODIFY_PATH=1 sh >/dev/null 2>&1 \
      || fail "下载 uv 失败，请检查网络"
  else
    curl -LsSf -m 300 https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$BIN_DIR" UV_NO_MODIFY_PATH=1 sh >/dev/null 2>&1 \
      || install_uv_from_mirror || fail "下载 uv 失败，请检查网络"
  fi
fi
UV="$(command -v uv)" || fail "找不到 uv"

echo "PROGRESS 30 准备 Python 3.12"
"$UV" python install 3.12 >/dev/null 2>&1 || fail "下载 Python 失败，请检查网络"
"$UV" venv --allow-existing --python 3.12 "$VENV" >/dev/null 2>&1 || fail "创建运行环境失败"

TARGET="$WORKER_DIR"
[[ -n "$EXTRA" ]] && TARGET="$WORKER_DIR[$EXTRA]"
case "$EXTRA" in
  *sensevoice*mlx*|*mlx*sensevoice*) echo "PROGRESS 55 安装 SenseVoice 与 Whisper 组件" ;;
  *sensevoice*) echo "PROGRESS 55 安装 SenseVoice 语音识别组件" ;;
  *mlx*) echo "PROGRESS 55 安装 Whisper 组件" ;;
  *) echo "PROGRESS 55 安装下载与转录组件" ;;
esac
if [[ -w "$WORKER_DIR" && -d "$WORKER_DIR/../.git" ]]; then
  VIRTUAL_ENV="$VENV" "$UV" pip install -q -e "$TARGET" 2>&1 | tail -5 || true
else
  VIRTUAL_ENV="$VENV" "$UV" pip install -q --reinstall-package favvault-worker "$TARGET" 2>&1 | tail -5 || true
fi
[[ -x "$VENV/bin/favvault-worker" ]] || fail "安装组件失败"

echo "PROGRESS 90 检查组件"
"$VENV/bin/favvault-worker" doctor >/dev/null 2>&1 || fail "组件自检失败"
echo "PROGRESS 100 完成"
echo "DONE"
