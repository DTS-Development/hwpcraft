import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostBridge, type HostBridgeDeps, type SaveSnapshot } from '../src/ppm/host-bridge.ts';
import {
  DEFAULT_VIEW_OPTIONS, SUPPORTED_OPEN_OPTIONS, getViewOptions, isReadOnlyAllowed, isReadOnlyKeyBlocked,
  isViewReadOnly, parseViewOptions, setViewOptions, READ_ONLY_ALLOWED_IDS,
} from '../src/ppm/view-state.ts';

const OLE = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2]);
const tick = () => new Promise((r) => setTimeout(r, 5));
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const src = (rel: string) => readFileSync(join(rootDir, rel), 'utf8');

function setup(over: Partial<HostBridgeDeps> = {}) {
  const posted: any[] = [];
  const events: string[] = [];
  const snap: SaveSnapshot = { format: 'hwp', name: 'a.hwp', bytes: new Uint8Array([9]), losses: [], lossCount: 0 };
  const deps: HostBridgeDeps = {
    post: (m) => posted.push(m),
    ready: async () => {},
    openDocument: async (n) => { events.push(`open:${n}`); },
    setOverrides: () => {},
    exportCurrent: () => snap,
    markSaved: async () => {},
    addFonts: async (f) => ({ installed: f.map((x) => x.family), failed: [] }),
    goto: () => ({ ok: true }),
    applyView: (v) => events.push(`view:${v.readOnly}/${v.chrome}/${v.zoomControls}`),
    setMutationGuard: (on) => events.push(`guard:${on}`),
    ...over,
  };
  return { bridge: createHostBridge(deps), posted, events };
}
const open = (bridge: any, name: string, extra: object = {}) =>
  bridge.handle({ type: 'hwpcraft:open', name, bytes: OLE, ...extra });

test('ready 에 지원 open 옵션 목록이 실린다', () => {
  const { bridge, posted } = setup();
  bridge.sendReady();
  assert.deepEqual(posted, [{ type: 'hwpcraft:ready', openOptions: ['readOnly', 'chrome', 'zoomControls'] }]);
  assert.deepEqual([...SUPPORTED_OPEN_OPTIONS], ['readOnly', 'chrome', 'zoomControls']);
});

test('옵션 파싱: 안 주면 기본값, 잘못된 타입도 기본값', () => {
  assert.deepEqual(parseViewOptions({}), DEFAULT_VIEW_OPTIONS);
  assert.deepEqual(parseViewOptions({ readOnly: 'yes', chrome: 0, zoomControls: 1 }), { readOnly: false, chrome: true, zoomControls: false });
  assert.deepEqual(parseViewOptions({ readOnly: true, chrome: false, zoomControls: true }), { readOnly: true, chrome: false, zoomControls: true });
});

test('open: 옵션은 열기 전에 적용되고 변경 방어선은 열기가 끝난 뒤 켜진다', async () => {
  const { bridge, events } = setup();
  open(bridge, 'a.hwp', { readOnly: true, chrome: false, zoomControls: true });
  await tick();
  assert.deepEqual(events, ['guard:false', 'view:true/false/true', 'open:a.hwp', 'guard:true']);
});

test('옵션 없는 다음 open 은 기본값으로 되돌린다', async () => {
  const { bridge, events } = setup();
  open(bridge, 'a.hwp', { readOnly: true, chrome: false });
  await tick();
  events.length = 0;
  open(bridge, 'b.hwp');
  await tick();
  assert.deepEqual(events, ['guard:false', 'view:false/true/false', 'open:b.hwp', 'guard:false']);
});

test('열기에 실패하면 앞 문서의 옵션으로 되돌린다', async () => {
  let fail = false;
  const { bridge, events, posted } = setup({
    openDocument: async (n) => { if (fail) throw new Error('boom'); events2.push(n); },
  });
  const events2: string[] = [];
  open(bridge, 'a.hwp', { readOnly: true });
  await tick();
  fail = true;
  const before = events.length;
  open(bridge, 'b.hwp', { chrome: false });
  await tick();
  assert.deepEqual(events.slice(before), ['guard:false', 'view:false/false/false', 'view:true/true/false', 'guard:true']);
  assert.equal(posted.at(-1).type, 'hwpcraft:failed');
});

test('읽기 전용 문서는 dirty·save 이벤트가 나가지 않는다', async () => {
  const { bridge, posted } = setup();
  open(bridge, 'a.hwp', { readOnly: true });
  await tick();
  posted.length = 0;
  bridge.sendDirty(true);
  await bridge.sendOutput({ name: 'a.hwp', bytes: new Uint8Array([1]), format: 'hwp' } as any);
  assert.deepEqual(posted, []);
  // 기본 문서에서는 지금처럼 나간다
  open(bridge, 'b.hwp');
  await tick();
  bridge.sendDirty(true);
  assert.deepEqual(posted.map((p) => p.type), ['hwpcraft:dirty']);
});

test('읽기 허용 명령: 목록 밖은 막는다', () => {
  for (const id of ['edit:copy', 'edit:find', 'view:zoom-in', 'view:page-width']) assert.ok(isReadOnlyAllowed(id), id);
  for (const id of ['edit:paste', 'edit:cut', 'edit:undo', 'edit:delete', 'file:save', 'format:bold', 'insert:table', 'view:form-mode', 'table:merge', 'unknown:new-command']) {
    assert.equal(isReadOnlyAllowed(id), false, id);
  }
});

test('키: 편집 키·조합키는 막고 이동·복사·찾기는 남긴다', () => {
  const k = (key: string, o: object = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
  for (const e of [k('Backspace'), k('Delete'), k('Enter'), k('Tab'), k('x', { ctrlKey: true }), k('v', { metaKey: true }), k('z', { ctrlKey: true }), k('b', { ctrlKey: true }), k('s', { ctrlKey: true }), k('Insert', { shiftKey: true })]) {
    assert.ok(isReadOnlyKeyBlocked(e), e.key);
  }
  for (const e of [k('ArrowDown'), k('PageUp'), k('c', { ctrlKey: true }), k('a', { metaKey: true }), k('f', { ctrlKey: true }), k('g', { altKey: true }), k('+', { ctrlKey: true }), k('Insert', { ctrlKey: true })]) {
    assert.equal(isReadOnlyKeyBlocked(e), false, e.key);
  }
});

test('보기 옵션 상태 저장소', () => {
  assert.equal(isViewReadOnly(), false);
  setViewOptions(parseViewOptions({ readOnly: true }));
  assert.equal(isViewReadOnly(), true);
  assert.equal(getViewOptions().readOnly, true);
  setViewOptions(DEFAULT_VIEW_OPTIONS);
  assert.equal(isViewReadOnly(), false);
});

// ── 드리프트: 새 명령이 생기면 읽기 허용 명단에서 일부러 분류하게 한다 ──────────────
test('드리프트: 읽기 허용 목록은 실제 명령 id 만 가리킨다', () => {
  const ids = new Set<string>();
  for (const rel of ['src/command/commands/edit.ts', 'src/command/commands/file.ts', 'src/command/commands/view.ts']) {
    let t = '';
    try { t = src(rel); } catch { continue; }
    for (const m of t.matchAll(/id:\s*'([a-z]+:[a-z0-9-]+)'/g)) ids.add(m[1]);
  }
  assert.ok(ids.size > 0, '명령 정의를 찾지 못함');
  for (const id of READ_ONLY_ALLOWED_IDS) {
    if (id.includes('.')) continue; // link.external 같은 정책 스위치 id
    assert.ok(ids.has(id), `${id} 는 명령 정의에 없다 → 읽기 허용 목록 갱신 필요`);
  }
});

test('배선: 편집 입구가 읽기 전용 검사를 거친다', () => {
  const ih = src('src/engine/input-handler.ts');
  assert.match(ih, /isViewReadOnly\(\) && desc\.kind !== 'record'/);
  assert.match(ih, /private onInput[\s\S]{0,120}isViewReadOnly/);
  assert.match(ih, /private onCompositionStart[\s\S]{0,120}isViewReadOnly/);
  assert.match(ih, /private onPaste[\s\S]{0,120}isViewReadOnly/);
  assert.match(ih, /private onCut[\s\S]{0,120}isViewReadOnly/);
  assert.match(src('src/engine/cursor.ts'), /enterPictureObjectSelectionDirect[\s\S]{0,900}isViewReadOnly/);
  assert.match(src('src/engine/input-handler-table.ts'), /startResizeDrag[\s\S]{0,200}isViewReadOnly/);
  const main = src('src/main.ts');
  assert.match(main, /if \(isViewReadOnly\(\)\) return; \/\/ 읽기 전용 문서에는 이미지/);
  assert.match(main, /document-mutated[\s\S]{0,80}isViewReadOnly/);
});
