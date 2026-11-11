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
  assert.equal(saveFileName('보고서.HWPX', 'hwpx'), '보고서.hwpx');
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
  assert.deepEqual(calls, []);
});

test('open 실패는 failed 로 알린다', async () => {
  const { bridge, posted } = setup({ openDocument: async () => { throw new Error('boom'); } });
  bridge.handle({ type: 'hwpcraft:open', name: 'x.hwp', bytes: OLE });
  await tick();
  assert.equal(posted[0].error, 'open: boom');
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
