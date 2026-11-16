import test from 'node:test';
import assert from 'node:assert/strict';
import { gotoLocation, GOTO_MAX_COUNT, GOTO_MAX_TEXT_BYTES, type GotoDeps, type GotoHit } from '../src/ppm/host-goto.ts';

const body = (para: number, charOffset = 0): GotoHit => ({ sec: 0, para, charOffset, length: 5 });
const cell = (parentPara: number, ctrlIdx: number, cellIdx: number, cellPara = 0): GotoHit => ({
  sec: 0, para: parentPara, charOffset: 0, length: 5, cellContext: { parentPara, ctrlIdx, cellIdx, cellPara },
});

function setup(hits: GotoHit[], over: Partial<GotoDeps> = {}) {
  const selected: GotoHit[] = [];
  const queries: string[] = [];
  const deps: GotoDeps = {
    findHits: (t) => { queries.push(t); return hits; },
    isTable: () => true,
    select: (h) => { selected.push(h); return true; },
    ...over,
  };
  return { deps, selected, queries };
}
const loc = (over: Record<string, unknown> = {}) => ({ kind: 'hwpx', story: 'body', text: '{{a}}', occurrence: 1, total: 1, ...over });

test('goto: occurrence 번째 일치를 선택한다', () => {
  const hits = [body(0), body(2), cell(3, 0, 1)];
  const { deps, selected } = setup(hits);
  assert.deepEqual(gotoLocation(loc({ occurrence: 2, total: 3 }), deps), { ok: true });
  assert.deepEqual(selected, [hits[1]]);
});

test('goto: 표 셀 일치도 선택한다(표인지 확인)', () => {
  const hits = [body(0), cell(3, 0, 1)];
  const asked: number[][] = [];
  const { deps, selected } = setup(hits, { isTable: (s, p, c) => { asked.push([s, p, c]); return true; } });
  assert.deepEqual(gotoLocation(loc({ occurrence: 2, total: 2 }), deps), { ok: true });
  assert.deepEqual(selected, [hits[1]]);
  assert.deepEqual(asked, [[0, 3, 0]]);
});

test('goto: 문단 자기 글자가 표 안 글자보다 먼저 센다(찾기 순서 그대로)', () => {
  // 한 문단 3 의 표(셀) 앞뒤 글자에 같은 태그: 찾기는 문단 자기 일치 둘을 먼저 준다.
  const hits = [body(3, 0), body(3, 20), cell(3, 0, 0)];
  const { deps, selected } = setup(hits);
  assert.deepEqual(gotoLocation(loc({ occurrence: 2, total: 3 }), deps), { ok: true });
  assert.equal(selected[0]!.charOffset, 20);
  assert.equal(selected[0]!.cellContext, undefined);
});

test('goto: 수식 스크립트 일치는 세지 않는다', () => {
  const hits = [{ ...body(0), equationControl: 0 }, body(1)];
  const { deps, selected } = setup(hits);
  assert.deepEqual(gotoLocation(loc({ occurrence: 1, total: 1 }), deps), { ok: true });
  assert.deepEqual(selected, [hits[1]]);
});

test('goto: 대소문자를 구분해 찾고 글자 그대로 넘긴다', () => {
  const { deps, queries } = setup([body(0)]);
  gotoLocation(loc({ text: '{{ Name }}' }), deps);
  assert.deepEqual(queries, ['{{ Name }}']);
});

test('goto: 부모가 센 수와 다르거나 순번이 넘으면 not-found', () => {
  const { deps, selected } = setup([body(0), body(1)]);
  assert.deepEqual(gotoLocation(loc({ occurrence: 1, total: 3 }), deps), { ok: false, reason: 'not-found' });
  assert.deepEqual(gotoLocation(loc({ occurrence: 3, total: 2 }), deps), { ok: false, reason: 'not-found' });
  assert.deepEqual(gotoLocation(loc(), setup([]).deps), { ok: false, reason: 'not-found' });
  assert.deepEqual(selected, []);
});

test('goto: 머리말·꼬리말·각주·미주는 unsupported', () => {
  for (const story of ['header', 'footer', 'footnote', 'endnote', 'masterPage']) {
    const { deps, queries } = setup([body(0)]);
    assert.deepEqual(gotoLocation(loc({ story }), deps), { ok: false, reason: 'unsupported' }, story);
    assert.deepEqual(queries, []);
  }
});

test('goto: hwpx 가 아닌 위치 종류는 unsupported', () => {
  const { deps } = setup([body(0)]);
  assert.deepEqual(gotoLocation({ kind: 'docx', story: 'body', text: 'a', occurrence: 1, total: 1 }, deps), { ok: false, reason: 'unsupported' });
  assert.deepEqual(gotoLocation({ kind: 'xlsx', sheet: 'S', cell: 'A1' }, deps), { ok: false, reason: 'unsupported' });
});

test('goto: 글상자 일치(표가 아닌 컨트롤)는 unsupported, 센 순서는 유지', () => {
  const hits = [body(0), cell(4, 1, 0)];
  const { deps, selected } = setup(hits, { isTable: () => false });
  assert.deepEqual(gotoLocation(loc({ occurrence: 2, total: 2 }), deps), { ok: false, reason: 'unsupported' });
  assert.deepEqual(selected, []);
  // 앞의 본문 일치는 글상자가 있어도 이동한다.
  assert.deepEqual(gotoLocation(loc({ occurrence: 1, total: 2 }), deps), { ok: true });
});

test('goto: 중첩 표(cellPath) 일치는 unsupported', () => {
  const nested: GotoHit = { sec: 0, para: 3, charOffset: 0, length: 5, cellPath: [{}, {}] };
  const { deps, selected } = setup([nested]);
  assert.deepEqual(gotoLocation(loc(), deps), { ok: false, reason: 'unsupported' });
  assert.deepEqual(selected, []);
});

test('goto: 잘못된 모양은 error', () => {
  const { deps } = setup([body(0)]);
  const bad: unknown[] = [
    null, 'x', 3,
    loc({ story: 'page' }), loc({ story: 1 }),
    loc({ text: '' }), loc({ text: 5 }), loc({ text: 'a'.repeat(GOTO_MAX_TEXT_BYTES + 1) }),
    loc({ text: '가'.repeat(Math.floor(GOTO_MAX_TEXT_BYTES / 3) + 1) }),
    loc({ occurrence: 0 }), loc({ occurrence: 1.5 }), loc({ occurrence: '1' }), loc({ occurrence: GOTO_MAX_COUNT + 1 }),
    loc({ total: 0 }), loc({ total: GOTO_MAX_COUNT + 1 }), loc({ total: undefined }),
  ];
  for (const b of bad) assert.deepEqual(gotoLocation(b, deps), { ok: false, reason: 'error' }, JSON.stringify(b));
});

test('goto: 찾기·선택 예외와 선택 실패는 error', () => {
  const origError = console.error;
  console.error = () => {};
  try {
    const hit = body(0);
    assert.deepEqual(gotoLocation(loc(), setup([hit], { findHits: () => { throw new Error('x'); } }).deps), { ok: false, reason: 'error' });
    assert.deepEqual(gotoLocation(loc(), setup([hit], { select: () => { throw new Error('x'); } }).deps), { ok: false, reason: 'error' });
    assert.deepEqual(gotoLocation(loc(), setup([hit], { select: () => false }).deps), { ok: false, reason: 'error' });
  } finally {
    console.error = origError;
  }
});
