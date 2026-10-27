#!/usr/bin/env bash
# Installs FavVault's processing components into ~/Library/Application Support/FavVault
# (or $FAVVAULT_HOME when set, e.g. by the 抖音知识库 Electron app).
# No Homebrew needed: uv is installed into the app folder, it fetches Python itself,
# and ffmpeg comes from the imageio-ffmpeg wheel.
#
# Usage: install-worker.sh [worker_dir] [extra]
#   worker_dir  path to the worker package (default: ../worker next to this script)
#   extra       "" (base) | "mlx" (adds Whisper on Apple Silicon) | "cpu"
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
if ! command -v uv >/dev/null 2>&1; then
  echo "PROGRESS 10 下载 uv"
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$BIN_DIR" UV_NO_MODIFY_PATH=1 sh >/dev/null 2>&1 \
    || fail "下载 uv 失败，请检查网络"
fi
UV="$(command -v uv)" || fail "找不到 uv"

echo "PROGRESS 30 准备 Python 3.12"
"$UV" python install 3.12 >/dev/null 2>&1 || fail "下载 Python 失败，请检查网络"
"$UV" venv --allow-existing --python 3.12 "$VENV" >/dev/null 2>&1 || fail "创建运行环境失败"

TARGET="$WORKER_DIR"
[[ -n "$EXTRA" ]] && TARGET="$WORKER_DIR[$EXTRA]"
if [[ "$EXTRA" == "mlx" ]]; then echo "PROGRESS 55 安装 Whisper 组件"; else echo "PROGRESS 55 安装下载与转录组件"; fi
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
