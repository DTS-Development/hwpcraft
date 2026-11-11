import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostBridge, sniffHwpFormat, saveFileName, type HostBridgeDeps, type SaveSnapshot } from '../src/ppm/host-bridge.ts';

const OLE = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2]);
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]);
const tick = () => new Promise((r) => setTimeout(r, 5));

function setup(over: Partial<HostBridgeDeps> = {}) {
  const posted: any[] = [];
  const calls: string[] = [];
  const snap: SaveSnapshot = { format: 'hwpx', name: 'a.hwp', bytes: new Uint8Array([9, 9]), losses: [], lossCount: 0 };
  const deps: HostBridgeDeps = {
    post: (m) => posted.push(m),
    ready: async () => {},
    openDocument: async (n) => { calls.push(`open:${n}`); },
    setOverrides: (o) => calls.push(`policy:${JSON.stringify(o)}`),
    exportCurrent: () => snap,
    markSaved: async (n) => { calls.push(`saved:${n}`); },
    addFonts: async (f) => ({ installed: f.map((x) => x.family), failed: [] }),
    ...over,
  };
  return { bridge: createHostBridge(deps), posted, calls, snap };
}

test('sniff: HWP·HWPX만 통과', () => {
  assert.equal(sniffHwpFormat(OLE), 'hwp');
  assert.equal(sniffHwpFormat(ZIP), 'hwpx');
  assert.equal(sniffHwpFormat(new TextEncoder().encode('%PDF-1.7')), null);
  assert.equal(sniffHwpFormat(new TextEncoder().encode('<?xml version')), null);
});

test('saveFileName: 형식에 맞는 확장자', () => {
  assert.equal(saveFileName('a.hwp', 'hwpx'), 'a.hwpx');
  assert.equal(saveFileName('', 'hwp'), 'document.hwp');
  // 형식에 맞는 확장자면 원래 표기(대소문자)를 그대로 쓴다. 부모는 open 의 name 과 글자 그대로 비교한다.
  assert.equal(saveFileName('보고서.HWPX', 'hwpx'), '보고서.HWPX');
  assert.equal(saveFileName('공문.HWP', 'hwp'), '공문.HWP');
  assert.equal(saveFileName('공문', 'hwp'), '공문.hwp');
  assert.equal(saveFileName('x.HWP', 'hwpx'), 'x.hwpx');
});

test('open: 정책을 적용하고 문서를 연다', async () => {
  const { bridge, calls, posted } = setup();
  bridge.handle({ type: 'hwpcraft:open', name: 'x.hwp', bytes: OLE, policy: { overrides: { 'file:print': true, bad: 1 } } });
  await tick();
  assert.deepEqual(calls, ['policy:{"file:print":true}', 'open:x.hwp']);
  assert.deepEqual(posted, []);
});

test('open: PDF·빈 바이트는 failed', async () => {
  const { bridge, posted, calls } = setup();
  bridge.handle({ type: 'hwpcraft:open', name: 'x.pdf', bytes: new TextEncoder().encode('%PDF-1.7----') });
  bridge.handle({ type: 'hwpcraft:open', name: 'x.hwp', bytes: new Uint8Array() });
  await tick();
  assert.equal(posted.length, 2);
  assert.ok(posted.every((p) => p.type === 'hwpcraft:failed'));
  assert.deepEqual(posted.map((p) => p.error), [
    'open: unsupported-format (HWP·HWPX 파일만 다룰 수 있습니다)',
    'open: invalid-bytes (문서 바이트가 비어 있거나 형식이 틀립니다)',
  ]);
  for (const p of posted) assert.match(String(p.error), /^(open|save|init): [a-z-]+ \(.+\)$/);
  assert.deepEqual(calls, []);
});

test('open 실패는 failed 로 알린다', async () => {
  const { bridge, posted } = setup({ openDocument: async () => { throw new Error('boom'); } });
  bridge.handle({ type: 'hwpcraft:open', name: 'x.hwp', bytes: OLE });
  await tick();
  assert.equal(posted[0].error, 'open: open-failed (문서를 열지 못했습니다)');
});

// 예외 원문(경로·스택 조각)은 어떤 오류 경로로도 부모에 가지 않는다.
const LEAKY = '/Users/kim/secret/a.hwp at parse (/srv/app/wasm.js:10:5)';
const noLeak = (o: unknown) => assert.ok(!/Users|secret|\/srv|\.js|at parse/.test(JSON.stringify(o)), JSON.stringify(o));

test('오류 문자열: open·export·save·init 실패에 경로·스택이 섞이지 않는다', async () => {
  const a = setup({ openDocument: async () => { throw new Error(LEAKY); } });
  a.bridge.handle({ type: 'hwpcraft:open', name: 'x.hwp', bytes: OLE });
  await tick();
  noLeak(a.posted);
  const b = setup({ exportCurrent: () => { throw new Error(LEAKY); } });
  b.bridge.handle({ type: 'hwpcraft:request-bytes', id: 'r-1', purpose: 'save' });
  await tick();
  assert.equal(b.posted[0].reason, 'export-failed');
  const saved = await b.bridge.saveFromUser();
  assert.deepEqual(saved, { ok: false, reason: 'export-failed' });
  assert.equal(b.posted[1].error, 'save: export-failed (문서를 저장 형식으로 만들지 못했습니다)');
  noLeak(b.posted);
  const c = setup();
  c.bridge.sendInitFailed(new Error(LEAKY));
  assert.equal(c.posted[0].error, 'init: init-failed (편집기를 시작하지 못했습니다)');
  noLeak(c.posted);
});

test('알려진 이유 코드(password-protected 등)는 그대로 전달한다', async () => {
  const { bridge } = setup({ exportCurrent: () => { throw new Error('unsupported-format'); } });
  assert.deepEqual(await bridge.saveFromUser(), { ok: false, reason: 'unsupported-format' });
});

test('request-bytes save: bytes 를 보내고 깨끗하게 만든다(열 때 형식, 확장자 보정)', async () => {
  const { bridge, posted, calls } = setup();
  bridge.handle({ type: 'hwpcraft:request-bytes', id: 'abc-1', purpose: 'save' });
  await tick();
  assert.equal(posted[0].type, 'hwpcraft:bytes');
  assert.equal(posted[0].name, 'a.hwpx');
  assert.equal(posted[0].purpose, 'save');
  assert.ok(posted[0].bytes instanceof ArrayBuffer);
  assert.deepEqual(calls, ['saved:a.hwpx']);
});

test('request-bytes check: 상태를 바꾸지 않는다', async () => {
  const { bridge, posted, calls } = setup();
  bridge.handle({ type: 'hwpcraft:request-bytes', id: 'abc-2', purpose: 'check' });
  await tick();
  assert.equal(posted[0].type, 'hwpcraft:bytes');
  assert.deepEqual(calls, []);
});

test('request-bytes: 손실 보고가 있으면 content-loss 로 거절하고 상세를 싣는다', async () => {
  const losses = Array.from({ length: 30 }, (_, i) => ({ code: 'controlOmitted', subject: 'control', path: `p${i}`, reason: 'unsupportedByOutputFormat' }));
  const { bridge, posted, calls } = setup({
    exportCurrent: () => ({ format: 'hwp', name: 'a.hwp', bytes: new Uint8Array([1]), losses, lossCount: 30 }),
  });
  bridge.handle({ type: 'hwpcraft:request-bytes', id: 'abc-3', purpose: 'save' });
  await tick();
  assert.equal(posted[0].type, 'hwpcraft:bytes-failed');
  assert.equal(posted[0].reason, 'content-loss');
  assert.equal(posted[0].detail.count, 30);
  assert.equal(posted[0].detail.losses.length, 20);
  assert.deepEqual(calls, []);
});

test('request-bytes: 내보내기 예외는 reason 으로, 잘못된 id 는 무응답', async () => {
  const { bridge, posted } = setup({ exportCurrent: () => { throw new Error('password-protected'); } });
  bridge.handle({ type: 'hwpcraft:request-bytes', id: 'ok-1', purpose: 'save' });
  bridge.handle({ type: 'hwpcraft:request-bytes', id: 'bad id!', purpose: 'save' });
  bridge.handle({ type: 'hwpcraft:request-bytes', id: 'ok-2', purpose: 'nope' });
  await tick();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].reason, 'password-protected');
});

test('request-bytes: 준비 전 실패는 not-ready', async () => {
  const { bridge, posted } = setup({ ready: async () => { throw new Error('x'); } });
  bridge.handle({ type: 'hwpcraft:request-bytes', id: 'r-1', purpose: 'save' });
  await tick();
  assert.equal(posted[0].reason, 'not-ready');
});

test('add-fonts: 설치/실패 목록', async () => {
  const { bridge, posted } = setup();
  bridge.handle({
    type: 'hwpcraft:add-fonts', id: 'f-1',
    fonts: [{ family: 'A', bytes: new Uint8Array([1]), format: 'ttf' }, { family: 'B', bytes: new Uint8Array(), format: 'otf' }, { family: 'C', bytes: new Uint8Array([1]), format: 'woff' }],
  });
  await tick();
  assert.deepEqual(posted[0], { type: 'hwpcraft:fonts-added', id: 'f-1', installed: ['A'], failed: ['B', 'C'] });
});

test('saveFromUser: 손실이면 거절, 아니면 save 메시지', async () => {
  const a = setup();
  assert.deepEqual(await a.bridge.saveFromUser(), { ok: true });
  assert.equal(a.posted[0].type, 'hwpcraft:save');
  const b = setup({ exportCurrent: () => ({ format: 'hwp', name: 'a', bytes: new Uint8Array([1]), losses: [], lossCount: 2 }) });
  assert.deepEqual(await b.bridge.saveFromUser(), { ok: false, reason: 'content-loss' });
  assert.equal(b.posted[0].type, 'hwpcraft:failed');
});

test('다른 접두사·형식 오류는 무시', async () => {
  const { bridge, posted, calls } = setup();
  bridge.handle({ type: 'wordcraft:open', name: 'x', bytes: OLE });
  bridge.handle(null);
  bridge.handle('x');
  await tick();
  assert.deepEqual([posted, calls], [[], []]);
});

test('사용자 저장: save 에 형식이 실리고 한 번만 나간다', async () => {
  const { bridge, posted, calls } = setup();
  const r = await bridge.saveFromUser();
  assert.deepEqual(r, { ok: true });
  assert.equal(posted.filter((p) => p.type === 'hwpcraft:save').length, 1);
  assert.equal(posted[0].format, 'hwpx');
  assert.deepEqual(calls, ['saved:a.hwpx']);
});

test('사용자 저장은 열기·bytes 요청과 같은 순서 큐를 탄다', async () => {
  let release!: () => void;
  const gateOpen = new Promise<void>((r) => { release = r; });
  const { bridge, posted } = setup({ openDocument: async () => { await gateOpen; } });
  bridge.handle({ type: 'hwpcraft:open', name: 'x.hwp', bytes: OLE });
  const saving = bridge.saveFromUser();
  await tick();
  assert.equal(posted.length, 0, 'open 이 끝나기 전에는 내보내지 않는다');
  release();
  await saving;
  assert.equal(posted.filter((p) => p.type === 'hwpcraft:save').length, 1);
});

test('sendOutput: 다른 형식 저장은 save 로 넘기고 문서 상태는 바꾸지 않는다', async () => {
  const { bridge, posted, calls } = setup();
  await bridge.sendOutput({ name: 'a.html', bytes: new Uint8Array([1, 2]), format: 'html' });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, 'hwpcraft:save');
  assert.equal(posted[0].format, 'html');
  assert.equal(posted[0].name, 'a.html');
  assert.deepEqual(calls, []);
});

test('sendOutput: 열 때와 이름·형식이 같으면 일반 저장처럼 깨끗한 상태로 돌린다', async () => {
  const { bridge, posted, calls } = setup();
  bridge.handle({ type: 'hwpcraft:open', name: '공문.hwp', bytes: OLE });
  await tick();
  await bridge.sendOutput({ name: '공문.hwp', bytes: new Uint8Array([1]), format: 'hwp' });
  assert.equal(posted.filter((p) => p.type === 'hwpcraft:save').length, 1);
  assert.ok(calls.includes('saved:공문.hwp'));
});

test('sendOutput: 이름이나 형식이 다르면 깨끗한 상태로 돌리지 않는다', async () => {
  const { bridge, calls } = setup();
  bridge.handle({ type: 'hwpcraft:open', name: '공문.hwp', bytes: OLE });
  await tick();
  await bridge.sendOutput({ name: '다른.hwp', bytes: new Uint8Array([1]), format: 'hwp' });
  await bridge.sendOutput({ name: '공문.hwp', bytes: new Uint8Array([1]), format: 'hwpx' });
  await bridge.sendOutput({ name: '공문.html', bytes: new Uint8Array([1]), format: 'html' });
  assert.equal(calls.filter((c) => c.startsWith('saved:')).length, 0);
});
