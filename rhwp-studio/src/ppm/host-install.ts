/**
 * PPM host 모드 설치 — main.ts 가 한 번 부른다.
 * 부모 창 연결·정책 게이트·메뉴 숨김·글꼴 보관소를 편집기에 붙인다. 순수 로직은 host-bridge·command-policy 에 있다.
 */
import type { CommandGate } from '../command/dispatcher.ts';
import { isExternalLinkBlockedBy } from './external-link.ts';
import { isCommandAllowed, sanitizeOverrides, type CommandOverrides } from './command-policy.ts';
import { createHostBridge, type SaveSnapshot, type HwpFormat } from './host-bridge.ts';
import { PpmHostFonts } from './host-fonts.ts';
import { isHostConnected, PPM_HOST_MARKER } from './host-mode.ts';

interface ReportArtifact { bytes: Uint8Array; contentLoss: { count: number; losses: SaveSnapshot['losses'] } }

export interface HostInstallOptions {
  dispatcher: { setGate(gate: CommandGate | null): void };
  knownCommandIds(): string[];
  eventBus: { on(name: string, handler: (payload: any) => void): unknown };
  wasm: {
    fileName: string;
    requiresPasswordForSave: boolean;
    getSourceFormat(): string;
    exportHwpWithReport(): ReportArtifact;
    exportHwpxWithReport(): ReportArtifact;
  };
  /** wasm 초기화. 실패하면 failed 를 보낸다. */
  initPromise: Promise<unknown>;
  /** 문서를 연다(저장 확인 없이 교체, 대화상자 억제). */
  loadDocument(name: string, bytes: Uint8Array): Promise<void>;
  /** 부모가 바이트를 받은 뒤 깨끗한 상태로 돌린다. */
  markSaved(name: string): Promise<unknown>;
  setFontProvider(provider: PpmHostFonts): void;
  /** 외부 링크 스위치를 편집기 링크 처리에 연결한다. */
  setExternalLinkBlocked(predicate: () => boolean): void;
}

/** 부모 없이 열었을 때 안내를 덮어 둔다. */
function showDisconnectedOverlay(): void {
  const el = document.createElement('div');
  el.setAttribute('role', 'alert');
  el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:#fff;color:#222;font:16px/1.5 sans-serif;text-align:center;padding:24px';
  el.textContent = 'PPM에서 열어 주세요. 이 편집기는 PPM 화면 안에서만 사용할 수 있습니다.';
  document.body.appendChild(el);
}

/** 설치에 성공해 부모와 연결되면 true. */
export function installPpmHost(opts: HostInstallOptions): boolean {
  document.documentElement.setAttribute('data-ppm-host', PPM_HOST_MARKER);
  const framed = window.parent !== window;
  if (!isHostConnected({ search: window.location.search, framed })) {
    showDisconnectedOverlay();
    return false;
  }

  let overrides: CommandOverrides = sanitizeOverrides({});
  const style = document.createElement('style');
  style.setAttribute('data-ppm-host-policy', '');
  document.head.appendChild(style);

  // 막힌 명령의 메뉴·도구막대 표면을 숨긴다(실행은 게이트가 따로 막는다).
  const refreshHiddenSurfaces = () => {
    const rules = opts.knownCommandIds()
      .filter((id) => !isCommandAllowed(id, overrides) && /^[A-Za-z0-9_.:-]+$/.test(id))
      .map((id) => `[data-cmd="${id}"]{display:none!important}`);
    style.textContent = rules.join('\n');
  };

  const fonts = new PpmHostFonts();
  opts.setFontProvider(fonts);
  opts.setExternalLinkBlocked(() => isExternalLinkBlockedBy(overrides));

  const bridge = createHostBridge({
    post: (message, transfer) => window.parent.postMessage(message, window.location.origin, transfer),
    ready: () => opts.initPromise.then(() => undefined),
    openDocument: async (name, bytes) => {
      await opts.loadDocument(name, bytes);
      if (opts.wasm.getSourceFormat() !== 'hwp' && opts.wasm.getSourceFormat() !== 'hwpx') {
        throw new Error('HWP·HWPX 가 아닌 문서입니다');
      }
    },
    setOverrides: (next) => { overrides = next; refreshHiddenSurfaces(); },
    exportCurrent: (): SaveSnapshot => {
      const w = opts.wasm;
      // 암호 문서는 부모가 열 수 없으므로 저장을 거절한다(암호화 기능은 막혀 있다).
      if (w.requiresPasswordForSave) throw new Error('password-protected');
      const source = w.getSourceFormat();
      if (source !== 'hwp' && source !== 'hwpx') throw new Error('unsupported-format');
      const format: HwpFormat = source;
      const artifact = format === 'hwpx' ? w.exportHwpxWithReport() : w.exportHwpWithReport();
      return {
        format, name: w.fileName, bytes: artifact.bytes,
        losses: artifact.contentLoss.losses, lossCount: artifact.contentLoss.count,
      };
    },
    markSaved: async (name) => { await opts.markSaved(name); },
    addFonts: async (list) => fonts.add(list),
  });

  const gate: CommandGate = (id) => {
    if (!isCommandAllowed(id, overrides)) return 'deny';
    // 저장은 로컬 파일이 아니라 부모에게 넘긴다.
    if (id === 'file:save') {
      void bridge.saveFromUser();
      return 'handled';
    }
    return 'allow';
  };
  opts.dispatcher.setGate(gate);
  refreshHiddenSurfaces();

  // 같은 출처의 부모 창이 보낸 메시지만 받는다.
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    bridge.handle(event.data);
  });

  opts.eventBus.on('document-dirty-changed', (payload: { dirty: boolean }) => bridge.sendDirty(payload.dirty));

  opts.initPromise.then(
    () => bridge.sendReady(),
    (e) => bridge.sendFailed(`init: ${e instanceof Error ? e.message : String(e)}`),
  );
  return true;
}
