#!/usr/bin/env node
// 배포물(dist/web)에 함께 가는 서드파티 고지 파일을 만든다.
//  - licenses/THIRD_PARTY_NPM.txt : 편집기 번들에 들어가는 npm 런타임 의존성의 이름·버전·라이선스·원문
//  - 라이선스에 GPL/AGPL/LGPL 이 보이면 실패한다.
// AI 도우미는 빌드에서 빠지므로(RHWP_WITHOUT_AI=1) @anthropic-ai/sdk 와 그 하위 의존성은 제외한다.
//
// 사용: node ppm/gen-notices.mjs <rhwp-studio 경로> <출력 파일>
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [studioArg, outArg] = process.argv.slice(2);
if (!studioArg || !outArg) {
  console.error('사용: node ppm/gen-notices.mjs <rhwp-studio 경로> <출력 파일>');
  process.exit(2);
}
const studio = resolve(studioArg);
const EXCLUDED = new Set(['@anthropic-ai/sdk']);
const BANNED = /\b(A?GPL|LGPL)\b/i;

const tree = JSON.parse(execFileSync('npm', ['ls', '--omit=dev', '--all', '--json'], { cwd: studio, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const found = new Map(); // name@version → { name, version }
(function walk(node) {
  for (const [name, child] of Object.entries(node.dependencies ?? {})) {
    if (EXCLUDED.has(name)) continue;
    found.set(`${name}@${child.version}`, { name, version: child.version });
    walk(child);
  }
})(tree);

/** node_modules 에서 패키지 디렉터리를 찾는다(중첩 설치 포함). */
function findPackageDir(name, version) {
  const candidates = [join(studio, 'node_modules', name)];
  const stack = [join(studio, 'node_modules')];
  while (stack.length) {
    const dir = stack.pop();
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const base = entry.name.startsWith('@') ? readdirSync(join(dir, entry.name)).map((n) => join(dir, entry.name, n)) : [join(dir, entry.name)];
      for (const p of base) {
        if (existsSync(join(p, 'node_modules'))) stack.push(join(p, 'node_modules'));
        candidates.push(p);
      }
    }
  }
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(join(p, 'package.json'), 'utf8'));
      if (pkg.name === name && pkg.version === version) return { dir: p, pkg };
    } catch { /* 다음 후보 */ }
  }
  return null;
}

const licenseOf = (pkg) => typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (pkg.licenses ?? []).map((l) => l.type).join(' OR ') ?? 'UNKNOWN';
const parts = ['편집기 번들에 들어가는 npm 런타임 의존성과 라이선스\n(rhwp-studio/package-lock.json 기준, AI 도우미 제외 빌드)\n'];
const problems = [];
for (const { name, version } of [...found.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  const hit = findPackageDir(name, version);
  if (!hit) { problems.push(`${name}@${version}: 설치된 패키지를 찾지 못함`); continue; }
  const license = licenseOf(hit.pkg) || 'UNKNOWN';
  if (BANNED.test(license)) problems.push(`${name}@${version}: 금지된 라이선스 ${license}`);
  const file = readdirSync(hit.dir).find((f) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(f));
  const text = file ? readFileSync(join(hit.dir, file), 'utf8').trim() : '(패키지에 라이선스 파일이 없음 — package.json 의 license 필드를 따른다)';
  parts.push(`${'='.repeat(72)}\n${name} ${version}\n라이선스: ${license}\n${'-'.repeat(72)}\n${text}\n`);
}
if (problems.length) {
  console.error(`고지 생성 실패:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
// canvaskit-wasm 은 wasm 안에 다른 프로젝트 코드를 함께 담고 있다.
parts.push(`${'='.repeat(72)}\ncanvaskit-wasm 에 함께 들어 있는 구성 요소\n${'-'.repeat(72)}\nSkia(BSD-3-Clause), FreeType(FreeType License 또는 GPLv2 중 FTL 선택), HarfBuzz(MIT), ICU(Unicode License)가 canvaskit.wasm 에 정적으로 묶여 있다. 각 원문은 canvaskit-wasm 소스의 third_party 와 위 LICENSE 를 따른다.\n`);
writeFileSync(resolve(outArg), parts.join('\n') + '\n');
console.log(`THIRD_PARTY_NPM.txt: ${found.size}개 패키지`);
