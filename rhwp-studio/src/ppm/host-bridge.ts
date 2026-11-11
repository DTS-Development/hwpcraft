/**
 * PPM host 모드 어댑터 — 부모 창(craft-bridge)과 `hwpcraft:*` 메시지를 주고받는다.
 *
 * 순수 로직만 둔다(DOM·wasm 의존 없음). 실제 편집기 동작은 deps 로 주입받아 node 테스트로 검증한다.
 * 메시지 규약은 wordcraft/gridcraft/deckcraft 와 같다:
 *   부모→편집기  open / request-bytes / add-fonts
 *   편집기→부모  ready / save / dirty / failed / bytes / bytes-failed / fonts-added
 */
import { sanitizeOverrides, type CommandOverrides } from './command-policy.ts';

export const PREFIX = 'hwpcraft';

/** bytes 요청 id 형식(craft-bridge 와 같다): 128자 이하 영숫자·하이픈. */
const REQUEST_ID = /^[A-Za-z0-9-]{1,128}$/;
const PURPOSES = ['save', 'check', 'preview'] as const;
type Purpose = (typeof PURPOSES)[number];

/** 글꼴 한 번에 받는 개수·크기 상한(HostFontProvider 한도 64MiB 와 맞춘다). */
export const MAX_FONTS_PER_REQUEST = 200;
export const MAX_FONT_BYTES = 64 * 1024 * 1024;
/** 손실 상세로 부모에 싣는 항목 수 상한. */
const LOSS_DETAIL_MAX = 20;

export type HwpFormat = 'hwp' | 'hwpx';

export interface FontInput { family: string; bytes: Uint8Array; format: 'ttf' | 'otf' }
export interface FontResult { installed: string[]; failed: string[] }

export interface LossRecord { code: string; subject: string; path: string; reason: string }

/** 현재 문서를 열 때 형식 그대로 내보낸 결과. */
export interface SaveSnapshot {
  format: HwpFormat;
  name: string;
  bytes: Uint8Array;
  losses: LossRecord[];
  lossCount: number;
}

export interface HostBridgeDeps {
  post(message: object, transfer?: Transferable[]): void;
  /** wasm 초기화가 끝날 때까지 기다린다. 실패하면 던진다. */
  ready(): Promise<void>;
  openDocument(name: string, bytes: Uint8Array): Promise<void>;
  setOverrides(overrides: CommandOverrides): void;
  /** 열 때 형식으로 내보낸다. 비밀번호 문서·로드 전이면 던진다(메시지가 reason 이 된다). */
  exportCurrent(): SaveSnapshot;
  /** 부모가 바이트를 받은 뒤 깨끗한 상태로 돌린다. */
  markSaved(name: string): Promise<void>;
  addFonts(fonts: FontInput[]): Promise<FontResult>;
}

/** 파일 앞머리로 HWP(OLE2)·HWPX(zip)만 통과시킨다. PDF·HML 등은 host 모드에서 거절. */
export function sniffHwpFormat(bytes: Uint8Array): HwpFormat | null {
  if (bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'hwp';
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'hwpx';
  return null;
}

/** 저장 파일명: 형식에 맞는 확장자로 맞춘다. */
export function saveFileName(name: string, format: HwpFormat): string {
  const base = (name || 'document').replace(/\.(hwp|hwpx)$/i, '');
  return `${base}.${format}`;
}

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) return bytes.buffer;
  return bytes.slice().buffer as ArrayBuffer;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export function createHostBridge(deps: HostBridgeDeps) {
  // open·bytes 요청이 서로 겹치지 않게 순서대로 처리한다.
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };

  const fail = (error: string) => deps.post({ type: `${PREFIX}:failed`, error });

  async function handleOpen(d: Record<string, unknown>): Promise<void> {
    const name = typeof d.name === 'string' ? d.name : '';
    const bytes = toBytes(d.bytes);
    if (!bytes || bytes.length === 0) return fail('open: bytes 가 비어 있거나 형식이 틀립니다');
    if (!sniffHwpFormat(bytes)) return fail('open: HWP·HWPX 파일만 열 수 있습니다');
    const policy = d.policy as { overrides?: unknown } | undefined;
    deps.setOverrides(sanitizeOverrides(policy?.overrides));
    try {
      await deps.ready();
      await deps.openDocument(name, bytes);
    } catch (e) {
      fail(`open: ${errText(e)}`);
    }
  }

  async function handleRequestBytes(d: Record<string, unknown>): Promise<void> {
    // id 형식이 틀리면 응답하지 않는다(craft-bridge 규약: 앱이 무응답).
    if (typeof d.id !== 'string' || !REQUEST_ID.test(d.id)) return;
    if (!PURPOSES.includes(d.purpose as Purpose)) return;
    const id = d.id;
    const purpose = d.purpose as Purpose;
    const reject = (reason: string, detail?: object) =>
      deps.post({ type: `${PREFIX}:bytes-failed`, id, purpose, reason, ...(detail ? { detail } : {}) });
    try {
      await deps.ready();
    } catch {
      return reject('not-ready');
    }
    let snap: SaveSnapshot;
    try {
      snap = deps.exportCurrent();
    } catch (e) {
      return reject(errText(e));
    }
    // 손실 보고가 있으면 거절한다(저장·검사 모두 같은 바이트를 쓰므로 목적과 무관).
    if (snap.lossCount > 0) {
      return reject('content-loss', { count: snap.lossCount, losses: snap.losses.slice(0, LOSS_DETAIL_MAX) });
    }
    const name = saveFileName(snap.name, snap.format);
    const buf = toArrayBuffer(snap.bytes);
    deps.post({ type: `${PREFIX}:bytes`, id, purpose, name, bytes: buf }, [buf]);
    // check·preview 는 문서 상태를 바꾸지 않는다.
    if (purpose === 'save') await deps.markSaved(name);
  }

  async function handleAddFonts(d: Record<string, unknown>): Promise<void> {
    if (typeof d.id !== 'string' || !REQUEST_ID.test(d.id)) return;
    const id = d.id;
    const list = Array.isArray(d.fonts) ? d.fonts.slice(0, MAX_FONTS_PER_REQUEST) : [];
    const fonts: FontInput[] = [];
    const failed: string[] = [];
    for (const f of list as Array<Record<string, unknown>>) {
      const family = typeof f?.family === 'string' ? f.family : '';
      const bytes = toBytes(f?.bytes);
      const format = f?.format === 'ttf' || f?.format === 'otf' ? f.format : null;
      if (!family || !bytes || !format || bytes.length === 0 || bytes.length > MAX_FONT_BYTES) {
        failed.push(family || '(이름 없음)');
        continue;
      }
      fonts.push({ family, bytes, format });
    }
    let result: FontResult = { installed: [], failed: [] };
    try {
      await deps.ready();
      if (fonts.length > 0) result = await deps.addFonts(fonts);
    } catch {
      result = { installed: [], failed: fonts.map((f) => f.family) };
    }
    deps.post({ type: `${PREFIX}:fonts-added`, id, installed: result.installed, failed: [...failed, ...result.failed] });
  }

  return {
    /** window message 이벤트 처리. 신뢰 검사(출처·source)는 호출한 쪽이 한다. */
    handle(data: unknown): void {
      if (typeof data !== 'object' || data === null) return;
      const d = data as Record<string, unknown>;
      if (typeof d.type !== 'string' || !d.type.startsWith(`${PREFIX}:`)) return;
      switch (d.type.slice(PREFIX.length + 1)) {
        case 'open':
          void enqueue(() => handleOpen(d));
          break;
        case 'request-bytes':
          void enqueue(() => handleRequestBytes(d));
          break;
        case 'add-fonts':
          void enqueue(() => handleAddFonts(d));
          break;
        default:
          break;
      }
    },
    sendReady(): void { deps.post({ type: `${PREFIX}:ready` }); },
    sendDirty(dirty: boolean): void { deps.post({ type: `${PREFIX}:dirty`, dirty }); },
    sendFailed(error: string): void { fail(error.slice(0, 200)); },
    /** 사용자가 파일 > 저장을 눌렀을 때. 손실이 있으면 거절하고 이유를 부모에 알린다. */
    async saveFromUser(): Promise<{ ok: true } | { ok: false; reason: string }> {
      let snap: SaveSnapshot;
      try {
        snap = deps.exportCurrent();
      } catch (e) {
        const reason = errText(e);
        fail(`save: ${reason}`);
        return { ok: false, reason };
      }
      if (snap.lossCount > 0) {
        fail(`save: content-loss (${snap.lossCount}건)`);
        return { ok: false, reason: 'content-loss' };
      }
      const name = saveFileName(snap.name, snap.format);
      const buf = toArrayBuffer(snap.bytes);
      deps.post({ type: `${PREFIX}:save`, name, bytes: buf }, [buf]);
      await deps.markSaved(name);
      return { ok: true };
    },
  };
}
