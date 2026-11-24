/**
 * PPM host 모드: 문서별 보기 옵션(readOnly·chrome·zoomControls)과 읽기 전용 판정.
 *
 * 순수 모듈(DOM·wasm 의존 없음)이라 node 테스트로 직접 검증한다.
 * 부모가 보낸 open 메시지에서 옵션을 읽고, 편집기 여러 곳이 `isViewReadOnly()` 로 같은 값을 본다.
 * 옵션을 안 준 open 은 기본값(편집 가능, 화면 그대로)이라 지금 동작과 같다.
 * 업스트림 빌드는 이 값을 바꾸는 코드가 실행되지 않으므로 항상 기본값이다.
 */

/** ready 메시지에 싣는 지원 옵션 목록(네 포크 공통 형태). 빌드 시점 상수다. */
export const SUPPORTED_OPEN_OPTIONS: readonly string[] = ['readOnly', 'chrome', 'zoomControls'];

export interface ViewOptions {
  /** true 면 문서 편집 입력·명령·저장 시도를 모두 막는다. */
  readonly readOnly: boolean;
  /** false 면 메뉴·도구 상자·서식 막대·눈금자·상태 막대를 숨긴다. */
  readonly chrome: boolean;
  /** chrome:false 일 때 확대 조절(쪽 단추·확대 묶음)만 상태 막대에 남긴다. */
  readonly zoomControls: boolean;
}

export const DEFAULT_VIEW_OPTIONS: ViewOptions = Object.freeze({ readOnly: false, chrome: true, zoomControls: false });

/** open 메시지에서 보기 옵션을 읽는다. 타입이 틀린 값은 기본값으로 본다(bridge 가 먼저 거른다). */
export function parseViewOptions(d: Record<string, unknown>): ViewOptions {
  return Object.freeze({
    readOnly: d.readOnly === true,
    chrome: d.chrome !== false,
    zoomControls: d.zoomControls === true,
  });
}

let current: ViewOptions = DEFAULT_VIEW_OPTIONS;

export function getViewOptions(): ViewOptions { return current; }
export function setViewOptions(next: ViewOptions): void { current = next; }
/** 지금 열린 문서가 읽기 전용이면 true. 편집 입력 경로의 첫 줄에서 부른다. */
export function isViewReadOnly(): boolean { return current.readOnly; }

/**
 * 읽기 전용에서 허용하는 명령 id. 목록에 없으면 막는다(새 명령은 기본이 막힘).
 * 보기·이동·찾기·복사·인쇄만 둔다. `link.external` 은 정책 스위치용 가짜 id 라 그대로 둔다(정책이 따로 정한다).
 */
export const READ_ONLY_ALLOWED_IDS: readonly string[] = [
  'edit:copy', 'edit:select-all', 'edit:find', 'edit:find-again', 'edit:goto',
  'file:about', 'file:print', // 인쇄는 문서를 바꾸지 않는다. 허용 여부는 호스트 정책(메뉴 막기)이 따로 정한다
  'link.external',
];

/** `view:` 명령은 모두 허용하되 양식 모드 전환(양식 값 편집을 연다)은 막는다. */
const READ_ONLY_DENIED_VIEW_IDS: readonly string[] = ['view:form-mode'];

export function isReadOnlyAllowed(id: string): boolean {
  if (id.startsWith('view:')) return !READ_ONLY_DENIED_VIEW_IDS.includes(id);
  return READ_ONLY_ALLOWED_IDS.includes(id);
}

/** 키 이벤트 중 판정에 쓰는 부분(구조적 타입). */
export interface KeyLike { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }

const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Escape']);
/** Ctrl/Cmd 와 함께 허용하는 글쇠: 복사·모두 선택·찾기·다시 찾기·찾아가기·인쇄(허용 여부는 정책이 정한다)·확대(+/-/0). 한글 두벌식 자모도 같이 둔다. */
const MOD_ALLOWED = new Set(['c', 'a', 'f', 'l', 'g', 'p', 'ㅔ', '+', '=', '-', '_', '0', 'ㅊ', 'ㅁ', 'ㄹ', 'ㅣ', 'ㅎ']);
/** Alt 와 함께 허용하는 글쇠: 찾아가기. */
const ALT_ALLOWED = new Set(['g', 'ㅎ']);

/**
 * 읽기 전용에서 keydown 을 막아야 하면 true. 글자 입력은 input·composition 이벤트에서 따로 막으므로
 * 여기서는 키 처리가 직접 문서를 바꾸는 키(지우기·줄바꿈·탭)와 허용 목록 밖의 조합키를 거른다.
 */
export function isReadOnlyKeyBlocked(e: KeyLike): boolean {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === 'Backspace' || key === 'Delete' || key === 'Enter' || key === 'Tab') return true;
  if (key === 'Insert') return !(mod && !e.shiftKey); // Ctrl+Insert(복사)만 통과
  if (NAV_KEYS.has(key)) return false;
  // Ctrl+F1·Ctrl+F2 는 도구 상자 전환(view: 명령, 허용)이라 명령 게이트가 판정하게 둔다.
  if (mod && (key === 'F1' || key === 'F2')) return false;
  if (mod) return !MOD_ALLOWED.has(key);
  if (e.altKey) return !ALT_ALLOWED.has(key);
  return false;
}
