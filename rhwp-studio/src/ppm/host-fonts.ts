/**
 * 관리자 글꼴(addFonts) 보관소 — HostFontProvider 로 편집기 글꼴 목록·렌더러에 연결된다.
 * 네트워크·로컬 글꼴 조회와 무관하게 부모가 보낸 바이트만 쓴다.
 */
import type { HostFontData, HostFontFace, HostFontProvider, HostFontSnapshot } from '../core/host-font-provider.ts';
import type { FontInput, FontResult } from './host-bridge.ts';
import { readSfntFaces } from './sfnt-names.ts';

interface Stored { face: HostFontFace; bytes: ArrayBuffer; faceIndex: number }

export class PpmHostFonts implements HostFontProvider {
  private stored = new Map<string, Stored>();
  private revision = 0;
  private listeners = new Set<() => void>();

  /** 글꼴을 올린다. 이름표를 못 읽는 파일은 failed. 같은 가족·스타일은 덮어쓴다. 반영 후 구독자에게 알린다. */
  add(fonts: FontInput[]): FontResult {
    const installed: string[] = [];
    const failed: string[] = [];
    for (const font of fonts) {
      const infos = readSfntFaces(font.bytes);
      if (infos.length === 0) { failed.push(font.family); continue; }
      const buffer = font.bytes.byteOffset === 0 && font.bytes.byteLength === font.bytes.buffer.byteLength
        ? (font.bytes.buffer as ArrayBuffer)
        : (font.bytes.slice().buffer as ArrayBuffer);
      for (const info of infos) {
        // 부모가 준 이름을 가족으로 쓰고, 파일 안의 이름은 별칭으로 둔다(문서가 어느 쪽 이름으로든 찾게).
        const aliases = [...new Set([info.family, info.fullName].filter((n) => n && n !== font.family))];
        const id = `${font.family}|${info.style}|${info.faceIndex}`;
        this.stored.set(id, {
          bytes: buffer,
          faceIndex: info.faceIndex,
          face: {
            id, family: font.family, fullName: info.fullName, postscriptName: info.postscriptName,
            style: info.style, aliases, weight: info.weight, slant: info.slant,
          },
        });
      }
      installed.push(font.family);
    }
    if (installed.length > 0) {
      this.revision += 1;
      for (const listener of [...this.listeners]) listener();
    }
    return { installed, failed };
  }

  async getSnapshot(): Promise<HostFontSnapshot> {
    return { revision: `ppm-${this.revision}`, faces: [...this.stored.values()].map((s) => s.face) };
  }

  async readFace(id: string, revision: string): Promise<HostFontData> {
    const s = this.stored.get(id);
    if (!s || revision !== `ppm-${this.revision}`) throw new Error('글꼴을 찾을 수 없습니다');
    return { bytes: s.bytes.slice(0), faceIndex: s.faceIndex };
  }

  subscribe(onChange: () => void): () => void {
    this.listeners.add(onChange);
    return () => { this.listeners.delete(onChange); };
  }
}
