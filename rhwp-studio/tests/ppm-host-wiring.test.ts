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

test('host 모드 소스 규칙: 문서 이력·파일 선택 우회·컴퓨터 글꼴 UI·다른 형식 저장', () => {
  const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
  // 문서 이력은 IndexedDB 대신 메모리만 쓴다.
  assert.match(read('history/idb-store.ts'), /if \(PPM_HOST\) return false;/);
  assert.match(read('ui/history-dialog.ts'), /if \(!PPM_HOST\) console\.log\(/);
  // #file-input 변경과 링크 대화상자의 파일 선택으로 문서가 열리지 않는다.
  assert.match(read('main.ts'), /if \(PPM_HOST\) \{ input\.value = ''; return; \}/);
  assert.match(read('ui/link-destination-dialog.ts'), /else if \(!PPM_HOST\) document\.getElementById\('file-input'\)/);
  // 컴퓨터 글꼴 불러오기 UI 와 안내 모달.
  assert.match(read('ui/options-dialog.ts'), /if \(!PPM_HOST\) panel\.appendChild\(localSection\)/);
  assert.match(read('main.ts'), /async function promptLocalFontsIfNeeded[^{]*\{[^}]*if \(PPM_HOST\) return;/s);
  // 다른 형식 저장·내보내기는 부모로 넘긴다.
  const file = read('command/commands/file.ts');
  assert.equal((file.match(/sendHostOutput\(/g) ?? []).length, 2);
  // 게이트는 판정만 한다: 게이트 함수 안에서 saveFromUser 를 부르지 않는다.
  const install = read('ppm/host-install.ts');
  const gateBody = install.slice(install.indexOf('const gate: CommandGate'), install.indexOf('opts.dispatcher.setGate'));
  assert.ok(!gateBody.includes('saveFromUser'));
});
