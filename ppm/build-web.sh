#!/usr/bin/env bash
# PPM 포크 웹 빌드: HWP/HWPX 편집기(rhwp-studio)를 host 모드로 묶어 dist/web 을 만든다.
# 필요: Rust(rust-toolchain.toml 의 1.93.1), wasm-pack 0.15.0, Node 22+, npm
# 옵션: --skip-wasm   이미 만든 pkg/ 를 그대로 쓴다(웹 쪽만 다시 빌드할 때)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
studio="$root/rhwp-studio"
out="$root/dist/web"

skip_wasm=0
case "${1:-}" in
  "") ;;
  --skip-wasm) skip_wasm=1 ;;
  *) echo "usage: $0 [--skip-wasm]" >&2; exit 2 ;;
esac

# 1) wasm (잠금 파일을 지키는 래퍼. pkg/ 와 rhwp-studio/public 에 같은 glue·wasm 이 놓인다)
if [ "$skip_wasm" != 1 ]; then
  (cd "$root" && sh scripts/wasm-pack-locked.sh build --target web --release)
fi
[ -f "$root/pkg/rhwp.js" ] || { echo "error: pkg/rhwp.js 가 없다(wasm 빌드 필요)" >&2; exit 1; }

# 2) 웹: host 모드 + AI·hwpctrl·외부 웹폰트 모두 끈다. 상대 경로(--base=./)라 어느 하위 경로에서도 뜬다.
cd "$studio"
npm ci --no-audit --no-fund
export RHWP_PPM_HOST=1 RHWP_WITHOUT_AI=1 RHWP_WITHOUT_HWPCTRL=1 RHWP_DISABLE_EXTERNAL_WEBFONTS=1
npx tsc
rm -rf "$out"
npx vite build --base=./ --outDir "$out" --emptyOutDir

# 3) host 표식 확인: 번들에 표식 문자열이 없으면 잠금이 꺼진 빌드다.
if ! grep -rlq "hwpcraft-ppm-host-build" "$out/assets"; then
  echo "error: 번들에 host 표식이 없다(RHWP_PPM_HOST 가 적용되지 않음)" >&2
  exit 1
fi
# AI 도우미가 번들에 남아 있으면 실패(외부 서비스 호출 코드)
if grep -rlq "api.anthropic.com\|generativelanguage.googleapis.com\|api.openai.com" "$out/assets"; then
  echo "error: 번들에 AI 제공자 주소가 남아 있다(RHWP_WITHOUT_AI 가 적용되지 않음)" >&2
  exit 1
fi

# 4) 배포에 필요 없는 것을 뺀다: 샘플 문서, 예비 wasm glue(public 복사본), 타입 선언.
#    wasm 은 assets/ 의 해시 파일 하나만 쓴다.
rm -rf "$out/samples"
rm -f "$out/rhwp.js" "$out/rhwp_bg.wasm" "$out/rhwp.d.ts" "$out/rhwp_bg.wasm.d.ts"

# 5) 라이선스 문제로 배포하지 않는 글꼴(Cafe24 서라운드·슈퍼매직, 해피니스 산스: 라이선스가 PDF 문서뿐)과 그 라이선스 PDF.
#    문서가 이 글꼴을 지정하면 같은 출처의 글꼴 파일 요청이 404가 되고 다른 글꼴로 대체된다.
rm -f "$out"/fonts/Cafe24*.woff2 "$out"/fonts/Happiness*.woff2 "$out"/fonts/HappinessSans*.woff2
rm -f "$out"/fonts/licenses/Cafe24*-LICENSE.pdf "$out"/fonts/licenses/HappinessSans-LICENSE.pdf

# 6) 관리자 화면이 읽는 명령 목록(등급 표에서 만들어 표와 어긋나지 않는다)과 고지
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
node "$root/ppm/gen-commands.mjs" "$studio" "$tmp"
chmod 644 "$tmp"
mv "$tmp" "$out/commands.json"
mkdir -p "$out/licenses"
node "$root/ppm/gen-notices.mjs" "$studio" "$out/licenses/THIRD_PARTY_NPM.txt"
cp "$root/LICENSE" "$out/licenses/rhwp-LICENSE"
cp "$root/THIRD_PARTY_LICENSES.md" "$out/licenses/THIRD_PARTY_LICENSES.md"

du -sh "$out"
