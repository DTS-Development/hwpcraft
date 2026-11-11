#!/usr/bin/env node
// PPM host 웹 빌드의 진입 HTML(index.html·print.html 등 dist/web 아래 *.html 전부)에 CSP meta 를 넣는다.
// 외부 출처 요청을 브라우저가 막게 하는 방어선이다. meta 로 못 거는 frame-ancestors 등은 서빙 쪽 헤더 몫.
// 사용: node ppm/inject-csp.mjs <dist/web 폴더>   (주입)
//       node ppm/inject-csp.mjs --check <dist/web 폴더>   (검사)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' blob: data:",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const META = `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`;

const ANY_CSP_META = /<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi;

/** html 문자열의 <head> 바로 뒤에 CSP meta 를 넣는다. 다른 스크립트보다 앞서야 한다. 이미 CSP meta 가 있으면 실패(느슨한 정책이 남는 것을 막는다). */
export function injectCsp(html) {
  if (new RegExp(ANY_CSP_META.source, 'i').test(html)) throw new Error('이미 CSP meta 가 있다');
  const m = /<head(\s[^>]*)?>/i.exec(html);
  if (!m) throw new Error('<head> 를 찾을 수 없다');
  const at = m.index + m[0].length;
  return `${html.slice(0, at)}\n  ${META}${html.slice(at)}`;
}

/** 폴더 안(하위 폴더 포함) *.html 전부에 넣는다. 처리한 파일 수를 돌려준다. */
export function injectDir(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) n += injectDir(p);
    else if (e.name.endsWith('.html')) {
      writeFileSync(p, injectCsp(readFileSync(p, 'utf8')));
      n += 1;
    }
  }
  return n;
}

/** 검사: 폴더 안 html 마다 CSP meta 가 정확히 1개이고 content 가 우리 CSP 와 글자 그대로 같아야 한다. 어긋난 파일 목록을 돌려준다. */
export function checkDir(dir) {
  const bad = [];
  let count = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const r = checkDir(p);
      bad.push(...r.bad);
      count += r.count;
    } else if (e.name.endsWith('.html')) {
      count += 1;
      const metas = readFileSync(p, 'utf8').match(ANY_CSP_META) ?? [];
      if (metas.length !== 1 || metas[0] !== META) bad.push(p);
    }
  }
  return { bad, count };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const check = process.argv[2] === '--check';
  const dir = check ? process.argv[3] : process.argv[2];
  if (!dir) { console.error('usage: inject-csp.mjs [--check] <dist/web>'); process.exit(2); }
  if (check) {
    const { bad, count } = checkDir(dir);
    if (count === 0 || bad.length > 0) { console.error(`error: CSP meta 검사 실패: ${count === 0 ? 'HTML 없음' : bad.join(', ')}`); process.exit(1); }
    console.log(`CSP meta 검사 통과: HTML ${count}개`);
    process.exit(0);
  }
  const n = injectDir(dir);
  if (n === 0) { console.error('error: CSP 를 넣을 HTML 이 없다'); process.exit(1); }
  console.log(`CSP meta 주입: HTML ${n}개`);
}
