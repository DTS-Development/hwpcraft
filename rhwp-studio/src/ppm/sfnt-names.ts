/**
 * SFNT(ttf·otf·ttc) 이름표 읽기 — 관리자 글꼴(addFonts)을 HostFontProvider 목록으로 올릴 때 쓴다.
 * 글꼴 파일에서 가족·전체 이름·PostScript 이름·굵기·기울임만 뽑는다. 렌더링용 파싱은 wasm 이 따로 한다.
 */

export interface SfntFaceInfo {
  faceIndex: number;
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  weight: number;
  slant: 'normal' | 'italic';
}

const MAX_FACES_IN_FILE = 256;
const MAX_NAME_RECORDS = 4096;

function tag(view: DataView, offset: number): string {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

/** 이름 레코드 문자열 해석: platform 0·3 은 UTF-16BE, 1 은 ASCII 범위만. */
function decodeName(view: DataView, start: number, length: number, platform: number): string {
  if (start + length > view.byteLength) return '';
  if (platform === 1) {
    let out = '';
    for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(start + i));
    return out;
  }
  let out = '';
  for (let i = 0; i + 1 < length; i += 2) out += String.fromCharCode(view.getUint16(start + i, false));
  return out;
}

function readTables(view: DataView, dirOffset: number): Map<string, { offset: number; length: number }> {
  const tables = new Map<string, { offset: number; length: number }>();
  if (dirOffset + 12 > view.byteLength) return tables;
  const numTables = view.getUint16(dirOffset + 4, false);
  for (let i = 0; i < numTables; i++) {
    const rec = dirOffset + 12 + i * 16;
    if (rec + 16 > view.byteLength) break;
    tables.set(tag(view, rec), { offset: view.getUint32(rec + 8, false), length: view.getUint32(rec + 12, false) });
  }
  return tables;
}

function readNames(view: DataView, table: { offset: number; length: number }): Map<number, string> {
  const names = new Map<number, string>();
  const base = table.offset;
  if (base + 6 > view.byteLength) return names;
  const count = Math.min(view.getUint16(base + 2, false), MAX_NAME_RECORDS);
  const stringBase = base + view.getUint16(base + 4, false);
  // 같은 id 는 영어(0x409/0x0)를 우선하고, 없으면 처음 나온 것을 쓴다.
  const rank = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const rec = base + 6 + i * 12;
    if (rec + 12 > view.byteLength) break;
    const platform = view.getUint16(rec, false);
    const lang = view.getUint16(rec + 4, false);
    const id = view.getUint16(rec + 6, false);
    if (platform !== 0 && platform !== 1 && platform !== 3) continue;
    const text = decodeName(view, stringBase + view.getUint16(rec + 10, false), view.getUint16(rec + 8, false), platform).trim();
    if (!text) continue;
    const score = (platform === 3 && lang === 0x409) ? 2 : (platform !== 3 && lang === 0) ? 1 : 0;
    if (!names.has(id) || score > (rank.get(id) ?? 0)) {
      names.set(id, text);
      rank.set(id, score);
    }
  }
  return names;
}

function readFace(view: DataView, dirOffset: number, faceIndex: number): SfntFaceInfo | null {
  const tables = readTables(view, dirOffset);
  const nameTable = tables.get('name');
  if (!nameTable) return null;
  const names = readNames(view, nameTable);
  const family = names.get(16) ?? names.get(1);
  if (!family) return null;
  const style = names.get(17) ?? names.get(2) ?? 'Regular';
  const fullName = names.get(4) ?? `${family} ${style}`.trim();
  let weight = 400;
  let italic = /italic|oblique/i.test(style);
  const os2 = tables.get('OS/2');
  if (os2 && os2.offset + 64 <= view.byteLength) {
    const w = view.getUint16(os2.offset + 4, false);
    if (w >= 1 && w <= 1000) weight = w;
    if (view.getUint16(os2.offset + 62, false) & 0x01) italic = true;
  }
  return {
    faceIndex, family, fullName, postscriptName: names.get(6) ?? '', style, weight,
    slant: italic ? 'italic' : 'normal',
  };
}

/** 글꼴 파일의 모든 face 정보. 형식이 틀리거나 이름을 못 읽으면 빈 배열. 던지지 않는다. */
export function readSfntFaces(bytes: ArrayBuffer | Uint8Array): SfntFaceInfo[] {
  try {
    const view = bytes instanceof Uint8Array
      ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new DataView(bytes);
    if (view.byteLength < 12) return [];
    const head = tag(view, 0);
    const faces: SfntFaceInfo[] = [];
    if (head === 'ttcf') {
      const n = Math.min(view.getUint32(8, false), MAX_FACES_IN_FILE);
      for (let i = 0; i < n; i++) {
        if (12 + i * 4 + 4 > view.byteLength) break;
        const face = readFace(view, view.getUint32(12 + i * 4, false), i);
        if (face) faces.push(face);
      }
    } else if (head === 'OTTO' || head === 'true' || view.getUint32(0, false) === 0x00010000) {
      const face = readFace(view, 0, 0);
      if (face) faces.push(face);
    }
    return faces;
  } catch {
    return [];
  }
}
