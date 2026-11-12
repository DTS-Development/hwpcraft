/**
 * 명령 정의를 거치지 않고 eventBus 로 서식을 직접 내보내는 조작 요소의 공통 출구.
 * 호스트 정책이 그 요소가 묶인 명령(control-commands.ts)을 껐다면 내보내지 않는다.
 * Toolbar 와 분리해 둔 것은 DOM 없이 동작(발행 횟수)을 시험하기 위해서다.
 */
export interface GuardDispatcher { isHostAllowed(commandId: string): boolean }
export interface GuardBus { emit(event: string, ...args: unknown[]): void }

/** 허용되면 내보내고 true, 막히면 아무것도 내보내지 않고 false. */
export function emitIfHostAllowed(dispatcher: GuardDispatcher, bus: GuardBus, commandId: string, event: string, payload: unknown): boolean {
  if (!dispatcher.isHostAllowed(commandId)) return false;
  bus.emit(event, payload);
  return true;
}
