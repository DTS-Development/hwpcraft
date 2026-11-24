/**
 * PPM host 모드 어댑터 — 부모 창(craft-bridge)과 `hwpcraft:*` 메시지를 주고받는다.
 *
 * 순수 로직만 둔다(DOM·wasm 의존 없음). 실제 편집기 동작은 deps 로 주입받아 node 테스트로 검증한다.
 * 메시지 규약은 wordcraft/gridcraft/deckcraft 와 같다:
 *   부모→편집기  open / request-bytes / add-fonts / goto
 *   편집기→부모  ready / save / dirty / failed / bytes / bytes-failed / fonts-added / goto-done / goto-failed
 */
import { sanitizeOverrides, type CommandOverrides } from './command-policy.ts';
import type { GotoOutcome } from './host-goto.ts';
import { DEFAULT_VIEW_OPTIONS, SUPPORTED_OPEN_OPTIONS, parseViewOptions, type ViewOptions } from './view-state.ts';

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
  /** 태그 위치로 이동해 선택한다. location 검사는 이 안에서 한다. */
  goto(location: unknown): GotoOutcome;
  /**
   * 문서별 보기 옵션(readOnly·chrome·zoomControls)을 입력·명령·화면에 적용한다. 문서를 열기 전에 부른다.
   * 안 주면 보기 옵션을 쓰지 않는 구성(기본 동작)이다.
   */
  applyView?(options: ViewOptions): void;
  /** 문서 변경 메서드를 막는 최후 방어선. 열기가 끝난 뒤에 켜고, 다음 열기 전에 끈다. */
  setMutationGuard?(on: boolean): void;
}

/** 파일 앞머리로 HWP(OLE2)·HWPX(zip)만 통과시킨다. PDF·HML 등은 host 모드에서 거절. */
export function sniffHwpFormat(bytes: Uint8Array): HwpFormat | null {
  if (bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'hwp';
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'hwpx';
  return null;
}

/**
 * 저장 파일명. 부모는 open 의 name 과 글자 그대로 비교하므로(대소문자 포함),
 * 이미 형식에 맞는 확장자면 원래 이름을 그대로 쓴다. 확장자가 없거나 형식과 다를 때만 맞춘다.
 */
export function saveFileName(name: string, format: HwpFormat): string {
  const raw = name || 'document';
  if (raw.toLowerCase().endsWith(`.${format}`)) return raw;
  return `${raw.replace(/\.(hwp|hwpx)$/i, '')}.${format}`;
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

/**
 * 부모로 보내는 오류는 고정된 이유 코드와 짧은 문구뿐이다. 예외 원문(경로·스택 조각이 섞일 수 있다)은
 * 부모로 보내지 않고 편집기 콘솔에만 남긴다.
 */
const REASON_TEXT = {
  'password-protected': '암호가 걸린 문서는 저장할 수 없습니다',
  'unsupported-format': 'HWP·HWPX 파일만 다룰 수 있습니다',
  'invalid-bytes': '문서 바이트가 비어 있거나 형식이 틀립니다',
  'export-failed': '문서를 저장 형식으로 만들지 못했습니다',
  'open-failed': '문서를 열지 못했습니다',
  'init-failed': '편집기를 시작하지 못했습니다',
} as const;
type ReasonCode = keyof typeof REASON_TEXT;

/** 내보내기 예외를 이유 코드로 바꾼다. 우리가 던지는 알려진 코드만 통과하고 나머지는 export-failed. */
function exportReason(e: unknown): ReasonCode {
  console.error('[hwpcraft] 내보내기 실패', e);
  const m = e instanceof Error ? e.message : '';
  return m === 'password-protected' || m === 'unsupported-format' ? m : 'export-failed';
}

/** failed 이벤트 문구: `<단계>: <코드> (<문구>)`. 단계 접두(open·save·init)는 기존과 같다. */
export function failureText(stage: 'open' | 'save' | 'init', code: ReasonCode): string {
  return `${stage}: ${code} (${REASON_TEXT[code]})`;
}

export function createHostBridge(deps: HostBridgeDeps) {
  // open·bytes 요청이 서로 겹치지 않게 순서대로 처리한다.
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };

  // 마지막으로 연 문서의 이름·형식. 같은 이름·같은 형식 저장은 부모가 일반 저장과 구분할 수 없다.
  let opened: { name: string; format: HwpFormat } | null = null;
  // 부모가 마지막으로 연 문서가 지금 편집기에 떠 있는지. 열기가 실패하면 편집기는 앞 문서를 되살리므로
  // 부모가 새 문서 기준으로 센 위치를 앞 문서에서 찾지 않도록, 열기가 끝나 성공할 때까지 goto 를 거절한다.
  let docMatchesParent = false;

  // 지금 문서에 적용된 보기 옵션. 열기에 실패하면 편집기가 앞 문서를 되살리므로 옵션도 이 값으로 되돌린다.
  let view: ViewOptions = DEFAULT_VIEW_OPTIONS;

  const fail = (error: string) => deps.post({ type: `${PREFIX}:failed`, error });

  async function handleOpen(d: Record<string, unknown>): Promise<void> {
    docMatchesParent = false;
    const name = typeof d.name === 'string' ? d.name : '';
    const bytes = toBytes(d.bytes);
    if (!bytes || bytes.length === 0) return fail(failureText('open', 'invalid-bytes'));
    const openFormat = sniffHwpFormat(bytes);
    if (!openFormat) return fail(failureText('open', 'unsupported-format'));
    const policy = d.policy as { overrides?: unknown } | undefined;
    deps.setOverrides(sanitizeOverrides(policy?.overrides));
    // 보기 옵션은 문서마다 따로다: 안 준 open 은 기본값으로 덮어쓴다. 입력·명령 차단과 화면은 열기 전에 켜고,
    // 변경 메서드 방어선은 열기 중 어떤 호출도 실패하지 않도록 열기가 끝난 뒤에 켠다.
    const prevView = view;
    const nextView = parseViewOptions(d);
    deps.setMutationGuard?.(false);
    view = nextView;
    deps.applyView?.(nextView);
    try {
      await deps.ready();
      await deps.openDocument(name, bytes);
      opened = { name, format: openFormat };
      docMatchesParent = true;
      deps.setMutationGuard?.(nextView.readOnly);
    } catch (e) {
      console.error('[hwpcraft] 문서 열기 실패', e);
      // 앞 문서가 되살아나므로 옵션도 앞 값으로 되돌린다(앞 문서가 없으면 기본값이다).
      view = prevView;
      deps.applyView?.(prevView);
      deps.setMutationGuard?.(prevView.readOnly && opened !== null);
      fail(failureText('open', 'open-failed'));
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
      return reject(exportReason(e));
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

  async function handleGoto(d: Record<string, unknown>): Promise<void> {
    // id 형식이 틀리면 응답하지 않는다(craft-bridge 규약).
    if (typeof d.id !== 'string' || !REQUEST_ID.test(d.id)) return;
    const id = d.id;
    const failed = (reason: string) => deps.post({ type: `${PREFIX}:goto-failed`, id, reason });
    // 열린 문서가 없으면 이동할 곳이 없다.
    if (!docMatchesParent) return failed('error');
    try {
      await deps.ready();
    } catch {
      return failed('error');
    }
    let outcome: GotoOutcome;
    try {
      outcome = deps.goto(d.location);
    } catch (e) {
      console.error('[hwpcraft] goto 실패', e);
      return failed('error');
    }
    if (outcome.ok) deps.post({ type: `${PREFIX}:goto-done`, id });
    else failed(outcome.reason);
  }

  async function saveNow(): Promise<{ ok: true } | { ok: false; reason: string }> {
    // 읽기 전용 문서는 저장 시도가 생기지 않는다(사용자 저장 경로의 최후 방어).
    if (view.readOnly) return { ok: false, reason: 'read-only' };
    let snap: SaveSnapshot;
    try {
      snap = deps.exportCurrent();
    } catch (e) {
      const reason = exportReason(e);
      fail(failureText('save', reason));
      return { ok: false, reason };
    }
    if (snap.lossCount > 0) {
      fail(`save: content-loss (${snap.lossCount}건)`);
      return { ok: false, reason: 'content-loss' };
    }
    const name = saveFileName(snap.name, snap.format);
    const buf = toArrayBuffer(snap.bytes);
    deps.post({ type: `${PREFIX}:save`, name, bytes: buf, format: snap.format }, [buf]);
    await deps.markSaved(name);
    return { ok: true };
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
        case 'goto':
          // 앞선 open 이 끝난 뒤에 처리한다.
          void enqueue(() => handleGoto(d));
          break;
        default:
          break;
      }
    },
    /** ready 에 지원하는 open 옵션 목록을 싣는다. 옛 빌드는 이 필드가 없어 bridge 가 새 옵션을 거절한다. */
    sendReady(): void { deps.post({ type: `${PREFIX}:ready`, openOptions: [...SUPPORTED_OPEN_OPTIONS] }); },
    sendDirty(dirty: boolean): void {
      // 읽기 전용 문서는 변경 이벤트가 생기지 않는다.
      if (view.readOnly && dirty) return;
      deps.post({ type: `${PREFIX}:dirty`, dirty });
    },
    /** 시작(wasm 초기화) 실패. 원문은 콘솔에만 남긴다. */
    sendInitFailed(e: unknown): void {
      console.error('[hwpcraft] 편집기 시작 실패', e);
      fail(failureText('init', 'init-failed'));
    },
    /** 사용자가 파일 > 저장을 눌렀을 때. 손실이 있으면 거절하고 이유를 부모에 알린다. */
    saveFromUser(): Promise<{ ok: true } | { ok: false; reason: string }> {
      // open·request-bytes 와 같은 순서 큐에 넣어, 문서가 바뀌는 중에 내보내지 않게 한다.
      return enqueue(() => saveNow());
    },
    /**
     * 정책으로 켠 다른 형식 저장·내보내기: 부모의 save 이벤트로 넘긴다.
     * 열 때와 이름·형식이 모두 같으면 부모가 일반 저장으로 받으므로 일반 저장과 같게 깨끗한 상태로 돌린다.
     * 그 밖에는 문서 상태(dirty)를 바꾸지 않는다.
     */
    async sendOutput(file: { name: string; bytes: Uint8Array; format: string }): Promise<void> {
      if (view.readOnly) return; // 읽기 전용 문서는 save 이벤트가 나가지 않는다.
      const buf = toArrayBuffer(file.bytes);
      deps.post({ type: `${PREFIX}:save`, name: file.name, bytes: buf, format: file.format }, [buf]);
      if (opened && file.name === opened.name && file.format === opened.format) await deps.markSaved(file.name);
    },
  };
}
