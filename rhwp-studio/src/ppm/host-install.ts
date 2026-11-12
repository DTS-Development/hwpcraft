/**
 * PPM host 모드 설치 — main.ts 가 한 번 부른다.
 * 부모 창 연결·정책 게이트·메뉴 숨김·글꼴 보관소를 편집기에 붙인다. 순수 로직은 host-bridge·command-policy 에 있다.
 */
import type { CommandGate } from '../command/dispatcher.ts';
import { isExternalLinkBlockedBy } from './external-link.ts';
import { isCommandAllowed, sanitizeOverrides, type CommandOverrides } from './command-policy.ts';
import { createHostBridge, type SaveSnapshot, type HwpFormat } from './host-bridge.ts';
import { CONTROL_BINDINGS } from './control-commands.ts';
import { CONTAINER_SELECTOR, PRUNE_ROOTS, SEPARATOR_SELECTOR, TRIGGER_SELECTOR, pruneChrome, type PruneRules } from './menu-prune.ts';
import { PpmHostFonts } from './host-fonts.ts';
import { setHostOutput } from './host-output.ts';
import { isHostConnected, PPM_HOST_MARKER } from './host-mode.ts';

interface ReportArtifact { bytes: Uint8Array; contentLoss: { count: number; losses: SaveSnapshot['losses'] } }

export interface HostInstallOptions {
  dispatcher: { setGate(gate: CommandGate | null): void; setHandledHandler(handler: ((commandId: string) => void) | null): void };
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

  // 정책 대상 조작 요소(data-cmd 또는 대응표 selector)와 그 빈 껍데기를 숨긴다.
  const HIDE_ATTR = 'data-ppm-hide';
  const pruneRules: PruneRules<Element> = {
    leafBlocked: (el) => {
      const cmd = el.getAttribute('data-cmd');
      if (cmd) return !isCommandAllowed(cmd, overrides);
      const bound = boundControls.get(el);
      return bound === undefined ? null : !isCommandAllowed(bound, overrides);
    },
    isContainer: (el) => el.matches(CONTAINER_SELECTOR),
    isSeparator: (el) => el.matches(SEPARATOR_SELECTOR),
    isTrigger: (el) => el.matches(TRIGGER_SELECTOR),
    setHidden: (el, hidden) => { el.toggleAttribute(HIDE_ATTR, hidden); },
  };
  let boundControls = new Map<Element, string>();

  // 막힌 명령의 메뉴·도구막대 표면을 숨긴다(실행은 게이트가 따로 막는다).
  const refreshHiddenSurfaces = () => {
    const rules = opts.knownCommandIds()
      .filter((id) => !isCommandAllowed(id, overrides) && /^[A-Za-z0-9_.:-]+$/.test(id))
      .map((id) => `[data-cmd="${id}"]{display:none!important}`);
    rules.push(`[${HIDE_ATTR}]{display:none!important}`);
    style.textContent = rules.join('\n');
    boundControls = new Map();
    for (const b of CONTROL_BINDINGS) {
      for (const el of document.querySelectorAll(b.selector)) boundControls.set(el, b.commandId);
    }
    for (const root of document.querySelectorAll(PRUNE_ROOTS)) pruneChrome(root, pruneRules);
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

  // 게이트는 isEnabled(메뉴 상태 조회)에서도 불리므로 판정만 한다. 저장은 파일 > 저장이 실제로 실행될 때만 부모로 넘긴다.
  const gate: CommandGate = (id) => {
    if (!isCommandAllowed(id, overrides)) return 'deny';
    return id === 'file:save' ? 'handled' : 'allow';
  };
  opts.dispatcher.setGate(gate);
  opts.dispatcher.setHandledHandler((id) => {
    if (id === 'file:save') void bridge.saveFromUser();
  });
  // 정책으로 켠 다른 형식 저장·내보내기도 부모로 넘긴다.
  setHostOutput((file) => bridge.sendOutput(file));
  refreshHiddenSurfaces();

  // 같은 출처의 부모 창이 보낸 메시지만 받는다.
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    bridge.handle(event.data);
  });

  opts.eventBus.on('document-dirty-changed', (payload: { dirty: boolean }) => bridge.sendDirty(payload.dirty));

  opts.initPromise.then(
    () => bridge.sendReady(),
    (e) => bridge.sendInitFailed(e),
  );
  return true;
}
