import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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
  assert.deepEqual(events, ['guard:false', 'view:true/false/true', 'open:a.hwp', 'view:true/false/true', 'guard:true']);
});

test('옵션 없는 다음 open 은 기본값으로 되돌린다', async () => {
  const { bridge, events } = setup();
  open(bridge, 'a.hwp', { readOnly: true, chrome: false });
  await tick();
  events.length = 0;
  open(bridge, 'b.hwp');
  await tick();
  // 열기 동안은 앞 문서(읽기 전용)의 잠금을 유지하고, 열기가 끝난 뒤 새 값(기본값)을 적용한다.
  assert.deepEqual(events, ['guard:false', 'view:true/true/false', 'open:b.hwp', 'view:false/true/false', 'guard:false']);
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
  assert.deepEqual(events.slice(before), ['guard:false', 'view:true/false/false', 'view:true/true/false', 'guard:true']);
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
  for (const id of ['edit:copy', 'edit:find', 'file:print', 'view:zoom-in', 'view:page-width']) assert.ok(isReadOnlyAllowed(id), id);
  for (const id of ['edit:paste', 'edit:cut', 'edit:undo', 'edit:delete', 'file:save', 'format:bold', 'insert:table', 'view:form-mode', 'table:merge', 'unknown:new-command']) {
    assert.equal(isReadOnlyAllowed(id), false, id);
  }
});

test('키: 편집 키·조합키는 막고 이동·복사·찾기는 남긴다', () => {
  const k = (key: string, o: object = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
  for (const e of [k('Backspace'), k('Delete'), k('Enter'), k('Tab'), k('x', { ctrlKey: true }), k('v', { metaKey: true }), k('z', { ctrlKey: true }), k('b', { ctrlKey: true }), k('s', { ctrlKey: true }), k('Insert', { shiftKey: true })]) {
    assert.ok(isReadOnlyKeyBlocked(e), e.key);
  }
  for (const e of [k('ArrowDown'), k('PageUp'), k('c', { ctrlKey: true }), k('a', { metaKey: true }), k('f', { ctrlKey: true }), k('g', { altKey: true }), k('p', { ctrlKey: true }), k('p', { metaKey: true }), k('F1', { ctrlKey: true }), k('+', { ctrlKey: true }), k('Insert', { ctrlKey: true })]) {
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
  const tx = src('src/engine/input-handler-text.ts');
  assert.match(tx, /export function onInput[\s\S]{0,120}isViewReadOnly/);
  assert.match(tx, /export function onCompositionStart[\s\S]{0,120}isViewReadOnly/);
  assert.match(ih, /private onPaste[\s\S]{0,120}isViewReadOnly/);
  assert.match(ih, /private onCut[\s\S]{0,120}isViewReadOnly/);
  assert.match(src('src/engine/cursor.ts'), /enterPictureObjectSelectionDirect[\s\S]{0,900}isViewReadOnly/);
  assert.match(src('src/engine/input-handler-table.ts'), /startResizeDrag[\s\S]{0,200}isViewReadOnly/);
  const main = src('src/main.ts');
  assert.match(main, /if \(isViewReadOnly\(\)\) return; \/\/ 읽기 전용 문서에는 이미지/);
  assert.match(main, /document-mutated[\s\S]{0,80}isViewReadOnly/);
});

test('읽기 전용 문서의 저장 요청은 read-only 로 거절하고 검사·미리보기는 답한다', async () => {
  const { bridge, posted } = setup();
  open(bridge, 'a.hwp', { readOnly: true });
  await tick();
  posted.length = 0;
  for (const purpose of ['save', 'check', 'preview']) bridge.handle({ type: 'hwpcraft:request-bytes', id: `r-${purpose}`, purpose });
  await tick();
  const by = (p: string) => posted.find((m) => m.id === `r-${p}`);
  assert.deepEqual([by('save').type, by('save').reason], ['hwpcraft:bytes-failed', 'read-only']);
  assert.equal(by('check').type, 'hwpcraft:bytes');
  assert.equal(by('preview').type, 'hwpcraft:bytes');
  // 기본 문서의 저장은 지금처럼 바이트를 돌려준다
  open(bridge, 'b.hwp');
  await tick();
  posted.length = 0;
  bridge.handle({ type: 'hwpcraft:request-bytes', id: 'r-save2', purpose: 'save' });
  await tick();
  assert.equal(posted[0].type, 'hwpcraft:bytes');
});

test('열기를 기다리는 동안 앞 읽기 전용 문서는 계속 잠겨 있다', async () => {
  let release: () => void = () => {};
  const seen: boolean[] = [];
  const { bridge } = setup({
    openDocument: () => new Promise<void>((r) => { release = r; }),
    applyView: (v) => seen.push(v.readOnly),
  });
  open(bridge, 'a.hwp', { readOnly: true });
  await tick(); release(); await tick();
  seen.length = 0;
  open(bridge, 'b.hwp'); // 옵션 없음
  await tick();
  assert.deepEqual(seen, [true]); // 열기 중에도 읽기 전용 유지
  release(); await tick();
  assert.deepEqual(seen, [true, false]); // 열기 성공 뒤 기본값
});

// ── 드리프트 ──────────────────────────────────────────────────────────────
test('드리프트: view: 명령 집합이 바뀌면 읽기 전용 분류를 다시 확인한다', () => {
  const t = src('src/command/commands/view.ts');
  const ids = [...t.matchAll(/id:\s*'(view:[a-z0-9-]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(ids, [
    'view:border-transparent', 'view:ctrl-mark', 'view:form-mode', 'view:grid-settings', 'view:para-mark',
    'view:toggle-clip', 'view:toggle-grid', 'view:toolbox-basic', 'view:toolbox-format', 'view:zoom-dialog',
    'view:zoom-fit-page', 'view:zoom-fit-width', 'view:zoom-in', 'view:zoom-out',
  ], '새 view: 명령은 문서를 바꾸지 않는지 확인하고, 바꾼다면 READ_ONLY_DENIED_VIEW_IDS 에 넣어야 한다');
});

test('드리프트: WasmBridge 를 거치지 않고 문서를 바꾸는 직접 호출은 알려진 곳뿐이다', () => {
    const hits: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(join(rootDir, dir))) {
      const rel = `${dir}/${f}`;
      if (statSync(join(rootDir, rel)).isDirectory()) { walk(rel); continue; }
      if (!rel.endsWith('.ts') || rel.endsWith('core/wasm-bridge.ts')) continue;
      if (/\.doc\.(set|insert|delete|apply|add|remove|move|resize|merge|split|update|toggle|replace|paste|create|clear)[A-Za-z]*\(/.test(src(rel))) hits.push(rel);
    }
  };
  walk('src');
  // page:hide(setPageHide)는 읽기 허용 목록 밖이라 닿지 않는다. 새 직접 호출이 생기면 방어선 밖이므로 분류를 확인한다.
  assert.deepEqual(hits, ['src/command/commands/page.ts']);
});
