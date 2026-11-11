import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { NON_DEFAULT_GRADES, LOCKED_COMMAND_IDS } from '../src/ppm/command-policy.ts';

const dir = new URL('../src/command/commands/', import.meta.url);
const commandSource = readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');

test('등급 표의 명령 id 는 실제 명령 정의에 있다(가짜 id link.external 제외)', () => {
  for (const id of Object.keys(NON_DEFAULT_GRADES)) {
    if (id === 'link.external') continue;
    assert.ok(commandSource.includes(`id: '${id}'`), `${id} 명령 정의를 찾을 수 없다`);
  }
});

test('locked 는 열기·새 문서·최근 문서뿐이다', () => {
  assert.deepEqual([...LOCKED_COMMAND_IDS].sort(), ['file:clear-recent', 'file:new-doc', 'file:open', 'file:open-recent']);
});

test('host 모드 소스 규칙: 네트워크·로컬 경로를 막는 분기가 남아 있다', () => {
  const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
  assert.match(read('core/local-fonts.ts'), /if \(PPM_HOST\) return \[\];/);
  assert.match(read('main.ts'), /if \(PPM_HOST\) return;\n/);
  assert.match(read('recent/recent-store.ts'), /if \(PPM_HOST\) return;/);
  assert.match(read('main.ts'), /if \(!PPM_HOST\) installEmbedRuntime/);
  assert.match(read('core/link-navigation.ts'), /if \(externalBlocked\(\)\) return false;/);
});
