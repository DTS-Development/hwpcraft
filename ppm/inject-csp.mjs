#!/usr/bin/env node
// PPM host 웹 빌드의 진입 HTML(index.html·print.html 등 dist/web 아래 *.html 전부)에 CSP meta 를 넣는다.
// 외부 출처 요청을 브라우저가 막게 하는 방어선이다. meta 로 못 거는 frame-ancestors 등은 서빙 쪽 헤더 몫.
// 사용: node ppm/inject-csp.mjs <dist/web 폴더>
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

/** html 문자열의 <head> 바로 뒤에 CSP meta 를 넣는다(이미 있으면 그대로). 다른 스크립트보다 앞서야 한다. */
export function injectCsp(html) {
  if (/http-equiv=["']Content-Security-Policy["']/i.test(html)) return html;
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: inject-csp.mjs <dist/web>'); process.exit(2); }
  const n = injectDir(dir);
  if (n === 0) { console.error('error: CSP 를 넣을 HTML 이 없다'); process.exit(1); }
  console.log(`CSP meta 주입: HTML ${n}개`);
}
