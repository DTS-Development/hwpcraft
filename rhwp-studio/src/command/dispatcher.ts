import type { EventBus } from '@/core/event-bus';
import type { CommandRegistry } from './registry';
import type { CommandResult, CommandServices, EditorContext } from './types';

const FORM_MODE_BLOCKED_IDS = new Set([
  'edit:cut',
  'edit:paste',
  'edit:delete',
  'field:edit',
  'field:remove',
  // [#2361 리뷰] 편집 용지의 파일 메뉴/F7 변형. page:setup 은 'page:' prefix 로 차단되는데
  // 이 변형만 열려 있었다 — 양식 모드에선 snapshot 이 드롭되므로(입력-핸들러 게이트) 다이얼로그가
  // 열리면 확인이 무언 폐기된다. 두 진입점을 동일하게 차단해 정합.
  'file:page-setup',
]);

const FORM_MODE_BLOCKED_PREFIXES = [
  'format:',
  'insert:',
  'table:',
  'page:',
];

function isBlockedInFormMode(commandId: string, ctx: EditorContext): boolean {
  if (!ctx.isFormMode) return false;
  if (FORM_MODE_BLOCKED_IDS.has(commandId)) return true;
  return FORM_MODE_BLOCKED_PREFIXES.some(prefix => commandId.startsWith(prefix));
}

/**
 * 호스트 정책 게이트(PPM host 모드). 'deny' 는 실행하지 않고, 'handled' 는 호스트가 대신 처리했다는 뜻이다.
 * 게이트가 없으면(기본 빌드) 동작은 그대로다.
 */
export type CommandGateResult = 'allow' | 'deny' | 'handled';
export type CommandGate = (commandId: string) => CommandGateResult;

/** 통합 커맨드 디스패처: 메뉴/툴바/키보드 모든 입력의 단일 실행 경로 */
export class CommandDispatcher {
  // 매개변수 속성 대신 명시 필드: node 의 타입 제거 실행(시험)에서도 읽히게 한다.
  private registry: CommandRegistry;
  private services: CommandServices;
  private eventBus: EventBus;

  constructor(registry: CommandRegistry, services: CommandServices, eventBus: EventBus) {
    this.registry = registry;
    this.services = services;
    this.eventBus = eventBus;
  }

  private gate: CommandGate | null = null;

  /** 호스트 정책 게이트를 건다. dispatch 와 isEnabled 가 모두 이 게이트를 지난다. */
  setGate(gate: CommandGate | null): void {
    this.gate = gate;
  }

  private onHandled: ((commandId: string) => void) | null = null;

  /**
   * 게이트가 'handled' 로 답한 명령의 실제 처리. 게이트는 isEnabled 에서도 불리므로 판정만 하고,
   * 부작용(예: 부모로 저장 넘기기)은 실행 경로인 dispatchWithResult 에서만 이 콜백으로 한다.
   */
  setHandledHandler(handler: ((commandId: string) => void) | null): void {
    this.onHandled = handler;
  }

  /**
   * 커맨드 실행.
   * @returns true: 실행됨, false: 미등록 또는 비활성
   */
  dispatch(commandId: string, params?: Record<string, unknown>): boolean {
    return this.dispatchWithResult(commandId, params).ok;
  }

  /**
   * 커맨드 실행 — 실패 사유까지 돌려준다.
   *
   * `dispatch()` 와 **같은 경로**다. 두 벌로 갈라 두면 한쪽 게이트만 고치는 드리프트가 생기므로
   * `dispatch()` 는 이 메서드의 결과에서 `ok` 만 꺼낸다. 로그·이벤트 발행도 여기 한 곳이다.
   */
  dispatchWithResult(commandId: string, params?: Record<string, unknown>): CommandResult {
    const def = this.registry.get(commandId);
    if (!def) {
      console.warn(`[CommandDispatcher] 미등록 커맨드: ${commandId}`);
      return { ok: false, reason: 'unregistered' };
    }

    const gated = this.gate?.(commandId) ?? 'allow';
    if (gated === 'deny') return { ok: false, reason: 'disabled' };
    if (gated === 'handled') {
      try {
        this.onHandled?.(commandId);
      } catch (err) {
        console.error(`[CommandDispatcher] 위임 처리 실패: ${commandId}`, err);
        return { ok: false, reason: 'threw', message: err instanceof Error ? err.message : String(err) };
      }
      return { ok: true };
    }

    const ctx = this.services.getContext();
    if (isBlockedInFormMode(commandId, ctx)) {
      return { ok: false, reason: 'blocked-in-form-mode' };
    }
    if (def.canExecute && !def.canExecute(ctx)) {
      // canExecute 실패 — 비활성 상태
      return { ok: false, reason: 'disabled' };
    }

    try {
      def.execute(this.services, params);
      // 커맨드 실행 후 UI 상태 갱신 알림
      this.eventBus.emit('command-state-changed');
      return { ok: true };
    } catch (err) {
      console.error(`[CommandDispatcher] 커맨드 실행 실패: ${commandId}`, err);
      return { ok: false, reason: 'threw', message: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 커맨드가 현재 활성(실행 가능)인지 확인.
   * 메뉴/툴바의 enabled/disabled 상태 갱신에 사용.
   */
  isEnabled(commandId: string): boolean {
    const def = this.registry.get(commandId);
    if (!def) return false;
    if (this.gate?.(commandId) === 'deny') return false;
    const ctx = this.services.getContext();
    if (isBlockedInFormMode(commandId, ctx)) return false;
    if (!def.canExecute) return true;
    return def.canExecute(ctx);
  }
}
