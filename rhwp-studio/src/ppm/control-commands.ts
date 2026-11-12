/**
 * PPM host 모드: `data-cmd` 가 없는 조작 요소(도구 상자·서식 막대·상태 표시줄) ↔ 명령 id 대응표.
 *
 * 정책으로 끈 명령은 메뉴뿐 아니라 이 요소들에서도 보이지 않고 실행되지도 않아야 한다.
 * - 숨김: host-install 이 이 표의 selector 를 찾아 `data-cmd` 와 같은 규칙으로 숨긴다.
 * - 실행: 이벤트를 직접 내보내는 요소는 아래 상수의 id 로 `dispatcher.isHostAllowed` 를 부른다.
 *   숨김 id 와 실행 id 가 한 상수라 어긋나지 않는다.
 * - 목록: ppm/gen-commands.mjs 가 이 표로 메뉴에 없는 명령의 location 을 채운다.
 * 순수 모듈(DOM 의존 없음)이라 node 테스트로 직접 검증한다.
 *
 * 묶음 근거: 명령 정의가 없는 글꼴·글자 크기·색·형광펜은 같은 속성을 편집하는 글자 모양 대화상자
 * (`format:char-shape`)에 묶는다. 크기 증감 화살표는 단축키와 같은 속성이라 `font-size-increase/decrease`,
 * 확대 가로바는 임의 배율을 정하는 `view:zoom-dialog` 에 묶는다.
 */

export type ControlSurface = 'toolbox' | 'format' | 'status';

/** location 에 쓰는 영어 이름(commands.json 의 label 과 같은 언어). */
export const SURFACE_LABELS: Readonly<Record<ControlSurface, string>> = {
  toolbox: 'Basic Toolbar',
  format: 'Format Toolbar',
  status: 'Status Bar',
};

/** 글꼴·언어·크기 입력·글자 색·형광펜이 함께 묶인 명령. */
export const CHAR_CONTROL_COMMAND = 'format:char-shape';
export const FONT_SIZE_UP_COMMAND = 'format:font-size-increase';
export const FONT_SIZE_DOWN_COMMAND = 'format:font-size-decrease';
/** 상태 표시줄 확대 가로바(임의 배율)가 묶인 명령. */
export const ZOOM_SLIDER_COMMAND = 'view:zoom-dialog';

export interface ControlBinding {
  /** 요소를 찾는 CSS selector. 정적 index.html 의 id 나 속성만 쓴다. */
  readonly selector: string;
  readonly commandId: string;
  readonly surface: ControlSurface;
}

const b = (surface: ControlSurface, selector: string, commandId: string): ControlBinding => ({ selector, commandId, surface });

export const CONTROL_BINDINGS: readonly ControlBinding[] = [
  // 기본 도구 상자 — data-cmd 를 붙이면 main.ts 가 .tb-btn[data-cmd] 클릭을 디스패치해 동작이 달라지므로 id 로 묶는다.
  b('toolbox', '#tb-cut', 'edit:cut'),
  b('toolbox', '#tb-copy', 'edit:copy'),
  b('toolbox', '#tb-paste', 'edit:paste'),
  b('toolbox', '#tb-bullet', 'format:apply-bullet'),

  // 서식 막대 — 글꼴 및 간격. 필드 전체(이름표 포함)를 묶는다.
  b('format', '#sbf-style', 'format:apply-style'),
  b('format', '#sbf-lang', CHAR_CONTROL_COMMAND),
  b('format', '#sbf-font', CHAR_CONTROL_COMMAND),
  b('format', '#sbf-size', CHAR_CONTROL_COMMAND),
  b('format', '#btn-size-up', FONT_SIZE_UP_COMMAND),
  b('format', '#btn-size-down', FONT_SIZE_DOWN_COMMAND),
  b('format', '#sbf-linespacing', 'format:line-spacing'),

  // 서식 막대 — 글자 모양
  b('format', '#btn-bold', 'format:bold'),
  b('format', '#btn-italic', 'format:italic'),
  b('format', '#btn-underline', 'format:underline'),
  b('format', '#btn-strike', 'format:strikethrough'),
  b('format', '#charfx-menu [data-format="emboss"]', 'format:emboss'),
  b('format', '#charfx-menu [data-format="engrave"]', 'format:engrave'),
  b('format', '#charfx-menu [data-format="outline"]', 'format:outline'),
  b('format', '#charfx-menu [data-format="superscript"]', 'format:superscript'),
  b('format', '#charfx-menu [data-format="subscript"]', 'format:subscript'),

  // 서식 막대 — 색
  b('format', '#sb-color-wrap', CHAR_CONTROL_COMMAND),
  b('format', '#highlight-dropdown', CHAR_CONTROL_COMMAND),

  // 서식 막대 — 문단 정렬
  b('format', '#btn-align-left', 'format:align-left'),
  b('format', '#btn-align-center', 'format:align-center'),
  b('format', '#btn-align-right', 'format:align-right'),
  b('format', '#btn-align-justify', 'format:align-justify'),
  b('format', '#btn-align-distribute', 'format:align-distribute'),
  b('format', '#btn-align-split', 'format:align-split'),

  // 상태 표시줄
  b('status', '#sb-page', 'edit:goto'),
  b('status', '#sb-zoom-fit-width', 'view:zoom-fit-width'),
  b('status', '#sb-zoom-fit', 'view:zoom-fit-page'),
  b('status', '#sb-zoom-out', 'view:zoom-out'),
  b('status', '#sb-zoom-range-wrap', ZOOM_SLIDER_COMMAND),
  b('status', '#sb-zoom-in', 'view:zoom-in'),
  b('status', '#sb-zoom-display', ZOOM_SLIDER_COMMAND),
];
