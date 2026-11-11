import test from 'node:test';
import assert from 'node:assert/strict';
import { readSfntFaces } from '../src/ppm/sfnt-names.ts';

/** 시험용 최소 SFNT: name 표(+선택 OS/2)만 가진다. */
function buildSfnt(names: Array<[number, string]>, opts: { weight?: number; italic?: boolean } = {}): Uint8Array {
  const recs = names.map(([id, s]) => {
    const b = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) { b[i * 2] = s.charCodeAt(i) >> 8; b[i * 2 + 1] = s.charCodeAt(i) & 0xff; }
    return { id, b };
  });
  const nameLen = 6 + recs.length * 12 + recs.reduce((a, r) => a + r.b.length, 0);
  const hasOs2 = opts.weight !== undefined || opts.italic;
  const numTables = hasOs2 ? 2 : 1;
  const dirLen = 12 + numTables * 16;
  const total = dirLen + nameLen + (hasOs2 ? 64 : 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x00010000);
  v.setUint16(4, numTables);
  const put = (i: number, t: string, off: number, len: number) => {
    for (let k = 0; k < 4; k++) out[12 + i * 16 + k] = t.charCodeAt(k);
    v.setUint32(12 + i * 16 + 8, off); v.setUint32(12 + i * 16 + 12, len);
  };
  put(0, 'name', dirLen, nameLen);
  if (hasOs2) put(1, 'OS/2', dirLen + nameLen, 64);
  const nb = dirLen;
  v.setUint16(nb + 2, recs.length);
  v.setUint16(nb + 4, 6 + recs.length * 12);
  let so = 0;
  recs.forEach((r, i) => {
    const rec = nb + 6 + i * 12;
    v.setUint16(rec, 3); v.setUint16(rec + 2, 1); v.setUint16(rec + 4, 0x409);
    v.setUint16(rec + 6, r.id); v.setUint16(rec + 8, r.b.length); v.setUint16(rec + 10, so);
    out.set(r.b, nb + 6 + recs.length * 12 + so);
    so += r.b.length;
  });
  if (hasOs2) {
    const o = dirLen + nameLen;
    v.setUint16(o + 4, opts.weight ?? 400);
    v.setUint16(o + 62, opts.italic ? 1 : 0);
  }
  return out;
}

test('이름표에서 가족·스타일·PostScript 이름을 읽는다', () => {
  const faces = readSfntFaces(buildSfnt([[1, 'Fam'], [2, 'Bold'], [4, 'Fam Bold'], [6, 'Fam-Bold']], { weight: 700 }));
  assert.equal(faces.length, 1);
  assert.deepEqual(
    { f: faces[0].family, s: faces[0].style, n: faces[0].fullName, p: faces[0].postscriptName, w: faces[0].weight, sl: faces[0].slant },
    { f: 'Fam', s: 'Bold', n: 'Fam Bold', p: 'Fam-Bold', w: 700, sl: 'normal' },
  );
});

test('name ID 16/17 이 1/2 보다 우선하고 OS/2 기울임을 읽는다', () => {
  const [face] = readSfntFaces(buildSfnt([[1, 'Fam Light'], [2, 'Regular'], [16, 'Fam'], [17, 'Light Italic']], { weight: 300, italic: true }));
  assert.equal(face.family, 'Fam');
  assert.equal(face.style, 'Light Italic');
  assert.equal(face.slant, 'italic');
});

test('깨진 입력·형식 아님은 빈 배열', () => {
  assert.deepEqual(readSfntFaces(new Uint8Array(3)), []);
  assert.deepEqual(readSfntFaces(new TextEncoder().encode('not a font at all')), []);
  const truncated = buildSfnt([[1, 'Fam']]).slice(0, 40);
  assert.deepEqual(readSfntFaces(truncated), []);
});

test('TTC: face 마다 읽는다', () => {
  const a = buildSfnt([[1, 'A']]);
  const b = buildSfnt([[1, 'B']]);
  const head = 12 + 8;
  const out = new Uint8Array(head + a.length + b.length);
  const v = new DataView(out.buffer);
  out.set([0x74, 0x74, 0x63, 0x66], 0);
  v.setUint32(8, 2); v.setUint32(12, head); v.setUint32(16, head + a.length);
  // 표 오프셋은 파일 처음 기준이라 각 서브 폰트의 표 위치를 이동시킨다.
  for (const [base, src] of [[head, a], [head + a.length, b]] as const) {
    out.set(src, base);
    const sv = new DataView(out.buffer, base);
    const n = sv.getUint16(4);
    for (let i = 0; i < n; i++) sv.setUint32(12 + i * 16 + 8, sv.getUint32(12 + i * 16 + 8) + base);
  }
  const faces = readSfntFaces(out);
  assert.deepEqual(faces.map((f) => [f.faceIndex, f.family]), [[0, 'A'], [1, 'B']]);
});

test('PpmHostFonts: 올린 글꼴이 스냅샷·readFace 로 나온다', async () => {
  const { PpmHostFonts } = await import('../src/ppm/host-fonts.ts');
  const store = new PpmHostFonts();
  const bytes = buildSfnt([[1, 'Inner'], [2, 'Regular'], [4, 'Inner Regular'], [6, 'Inner-Regular']]);
  const res = store.add([{ family: 'Admin', bytes, format: 'ttf' }, { family: 'Bad', bytes: new Uint8Array(20), format: 'otf' }]);
  assert.deepEqual(res, { installed: ['Admin'], failed: ['Bad'] });
  const snap = await store.getSnapshot();
  assert.equal(snap.faces.length, 1);
  assert.equal(snap.faces[0].family, 'Admin');
  assert.deepEqual([...(snap.faces[0].aliases ?? [])], ['Inner', 'Inner Regular']);
  const data = await store.readFace(snap.faces[0].id, snap.revision);
  assert.equal(data.bytes.byteLength, bytes.length);
  await assert.rejects(store.readFace(snap.faces[0].id, 'old'));
});
