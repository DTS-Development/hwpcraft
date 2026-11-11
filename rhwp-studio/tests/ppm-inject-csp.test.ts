import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error 타입 선언 없는 .mjs
import { CSP, injectCsp, injectDir } from '../../ppm/inject-csp.mjs';

test('CSP: 외부 출처 없이 self·blob·data 만, wasm 평가는 wasm-unsafe-eval 로만', () => {
  assert.match(CSP, /^default-src 'self'; /);
  assert.ok(!/https?:|\*/.test(CSP));
  assert.ok(!/'unsafe-eval'/.test(CSP));
  assert.match(CSP, /script-src 'self' 'wasm-unsafe-eval'(;|$)/);
  assert.match(CSP, /object-src 'none'/);
});

test('injectCsp: head 바로 뒤(스크립트보다 앞)에 한 번만 넣는다', () => {
  const html = '<!DOCTYPE html><html><head>\n<script src="./a.js"></script></head><body></body></html>';
  const out = injectCsp(html);
  assert.ok(out.indexOf('Content-Security-Policy') < out.indexOf('<script'));
  assert.equal(injectCsp(out), out);
  assert.throws(() => injectCsp('<p>no head</p>'));
});

test('injectDir: 하위 폴더 포함 html 전부에 넣는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'csp-'));
  mkdirSync(join(dir, 'sub'));
  for (const f of ['index.html', 'print.html', 'sub/x.html']) writeFileSync(join(dir, f), '<html><head></head></html>');
  assert.equal(injectDir(dir), 3);
  for (const f of ['index.html', 'print.html', 'sub/x.html']) assert.match(readFileSync(join(dir, f), 'utf8'), /Content-Security-Policy/);
});
