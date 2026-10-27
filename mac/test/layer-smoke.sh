#!/bin/bash
# 增量更新冒烟测试（macOS，真实 Electron）。
# 用法：test/layer-smoke.sh <抖音知识库.app> [新应用层 asar] [新版本号]
#   不给新应用层时，用安装包内置的 app.asar 改个版本号（内置版本 +0.0.1）当作“新版本”。
# 检查：① 无更新 → 内置层 ② 放入新层 → 加载新层 ③ 新层被篡改 → 退回内置并标记坏版本
#       ④ 新层 main.js 抛错 → 自动重启回内置 ⑤ 新层连续崩溃 2 次 → 第 3 次退回内置
set -euo pipefail
APP="$(cd "$1" && pwd)"; NEW_ASAR="${2:-}"; NEW_VER="${3:-}"
[ -z "${NEW_ASAR}" ] || NEW_ASAR="$(cd "$(dirname "${NEW_ASAR}")" && pwd)/$(basename "${NEW_ASAR}")"
BIN="${APP}/Contents/MacOS/$(plutil -extract CFBundleExecutable raw "${APP}/Contents/Info.plist")"
BUNDLED_ASAR="${APP}/Contents/Resources/app.asar"
WORK="$(mktemp -d)"
export DKV_UPDATES_DIR="${WORK}/updates"
ASAR="npx --yes @electron/asar"
pass() { echo "LAYER-SMOKE PASS $*"; }
die() { echo "LAYER-SMOKE FAIL $*"; [ -f "${DKV_UPDATES_DIR}/state.json" ] && cat "${DKV_UPDATES_DIR}/state.json"; exit 1; }
jget() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split("/").reduce((o,k)=>o==null?o:o[k],j);console.log(typeof v==="object"?JSON.stringify(v):v)' "$1" "$2"; }

# 启动应用并等它写出 --print-layer 文件（可能经过一次自动重启），超时 90 秒
run_print() {
  local out="$1"; rm -f "${out}"
  "${BIN}" --print-layer="${out}" >"${out}.log" 2>&1 &
  local pid=$! i=0
  while [ ${i} -lt 90 ]; do
    [ -s "${out}" ] && break
    sleep 1; i=$((i+1))
  done
  kill "${pid}" 2>/dev/null || true
  wait "${pid}" 2>/dev/null || true
  # 等可能存在的重启实例退出
  sleep 2
  pkill -f -- "--print-layer=${out}" 2>/dev/null || true
  [ -s "${out}" ] || { echo "--- log"; cat "${out}.log" || true; return 1; }
  cat "${out}"
}
# 启动一个预期会崩溃的应用层（不会写出文件），最多等 30 秒
run_crash() {
  local out="${WORK}/crash.json"; rm -f "${out}"
  "${BIN}" --print-layer="${out}" >"${WORK}/crash.log" 2>&1 &
  local pid=$! i=0
  while kill -0 "${pid}" 2>/dev/null && [ ${i} -lt 30 ]; do sleep 1; i=$((i+1)); done
  kill -9 "${pid}" 2>/dev/null || true
  [ ! -s "${out}" ] || { cat "${out}"; die "崩溃层居然写出了版本文件"; }
}
manifest() { # <asar> <version> <electron> <out.json>
  node -e '
    const fs=require("fs"),c=require("crypto"),[a,v,e,o]=process.argv.slice(1);
    const b=fs.readFileSync(a);
    fs.writeFileSync(o, JSON.stringify({version:v,electron:e,bootstrap:1,sha256:c.createHash("sha256").update(b).digest("hex"),size:b.length,file:"app-"+v+".asar"},null,2));
  ' "$1" "$2" "$3" "$4"
}
make_layer() { # <version> <main.js 前插入的代码或空> <out.asar>
  local d="${WORK}/layer-$1"; rm -rf "${d}"
  ${ASAR} extract "${BUNDLED_ASAR}" "${d}"
  node -e 'const f=process.argv[1]+"/package.json",j=JSON.parse(require("fs").readFileSync(f));j.version=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(j,null,2))' "${d}" "$1"
  if [ -n "$2" ]; then printf '%s\n' "$2" | cat - "${d}/main.js" > "${d}/main.js.new" && mv "${d}/main.js.new" "${d}/main.js"; fi
  ${ASAR} pack "${d}" "$3"
}
install_layer() { # <asar> <version>
  mkdir -p "${DKV_UPDATES_DIR}"
  cp "$1" "${DKV_UPDATES_DIR}/app-$2.asar"
  manifest "${DKV_UPDATES_DIR}/app-$2.asar" "$2" "${ELECTRON}" "${DKV_UPDATES_DIR}/app-$2.json"
}

# ---- ① 无更新 ----
O="${WORK}/p1.json"; run_print "${O}" || die "① 应用没有写出版本文件"
BUNDLED_VER="$(jget "${O}" bundledVersion)"; ELECTRON="$(jget "${O}" electron)"
[ "$(jget "${O}" source)" = bundled ] && [ "$(jget "${O}" version)" = "${BUNDLED_VER}" ] && [ "$(jget "${O}" rendererOk)" = true ] || die "① 应该加载内置层"
pass "① 无更新 → 内置层 v${BUNDLED_VER}（Electron ${ELECTRON}）"

# ---- ② 新应用层 ----
if [ -z "${NEW_ASAR}" ]; then
  NEW_VER="$(node -e 'const [a,b,c]=process.argv[1].split(".").map(Number);console.log(`${a}.${b}.${c+1}`)' "${BUNDLED_VER}")"
  NEW_ASAR="${WORK}/new.asar"; make_layer "${NEW_VER}" "" "${NEW_ASAR}"
fi
install_layer "${NEW_ASAR}" "${NEW_VER}"
O="${WORK}/p2.json"; run_print "${O}" || die "② 应用没有写出版本文件"
[ "$(jget "${O}" source)" = update ] && [ "$(jget "${O}" version)" = "${NEW_VER}" ] && [ "$(jget "${O}" rendererOk)" = true ] || die "② 应该加载新应用层 v${NEW_VER}"
case "$(jget "${O}" root)" in *"app-${NEW_VER}.asar"*) ;; *) die "② main.js 不是从新应用层加载的";; esac
[ "$(jget "${DKV_UPDATES_DIR}/state.json" "boots/${NEW_VER}/good")" = true ] || die "② 没有记录成功启动"
pass "② 放入新应用层 → 加载 v${NEW_VER}（$(jget "${O}" root)）"

# ---- ③ 篡改 asar（大小不变）→ 退回内置 ----
node -e 'const fs=require("fs"),f=process.argv[1],b=fs.readFileSync(f);b[b.length-10]^=0xff;fs.writeFileSync(f,b)' "${DKV_UPDATES_DIR}/app-${NEW_VER}.asar"
O="${WORK}/p3.json"; run_print "${O}" || die "③ 应用没有写出版本文件"
[ "$(jget "${O}" source)" = bundled ] && [ "$(jget "${O}" version)" = "${BUNDLED_VER}" ] || die "③ 篡改后应该退回内置层"
jget "${DKV_UPDATES_DIR}/state.json" "bad/${NEW_VER}" | grep -q sha256 || die "③ 没有标记坏版本"
pass "③ asar 被篡改 → 退回内置层，v${NEW_VER} 标记为坏版本"

# ---- ④ 新层启动时抛异常 → 自动重启回内置 ----
rm -rf "${DKV_UPDATES_DIR}"
make_layer 9.9.1 'throw new Error("boom from broken layer");' "${WORK}/throw.asar"
install_layer "${WORK}/throw.asar" 9.9.1
O="${WORK}/p4.json"; run_print "${O}" || die "④ 抛错层：没有自动退回内置层"
[ "$(jget "${O}" source)" = bundled ] || die "④ 应该退回内置层"
jget "${DKV_UPDATES_DIR}/state.json" "bad/9.9.1" | grep -q boom || die "④ 没有记录失败原因"
pass "④ 新层 main.js 抛错 → 自动重启并退回内置层"

# ---- ⑤ 新层连续崩溃 2 次 → 第 3 次退回内置 ----
rm -rf "${DKV_UPDATES_DIR}"
make_layer 9.9.2 'process.crash();' "${WORK}/crash.asar"
install_layer "${WORK}/crash.asar" 9.9.2
run_crash; run_crash
[ "$(jget "${DKV_UPDATES_DIR}/state.json" "boots/9.9.2/attempts")" = 2 ] || die "⑤ 崩溃次数没有记录"
O="${WORK}/p5.json"; run_print "${O}" || die "⑤ 第 3 次启动没有写出版本文件"
[ "$(jget "${O}" source)" = bundled ] || die "⑤ 连续崩溃后应该退回内置层"
jget "${DKV_UPDATES_DIR}/state.json" "bad/9.9.2" | grep -q "连续 2 次" || die "⑤ 没有标记坏版本"
pass "⑤ 新层连续崩溃 2 次 → 第 3 次退回内置层"
echo "LAYER-SMOKE ALL PASSED"
