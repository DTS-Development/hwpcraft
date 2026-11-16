/**
 * 부모가 보낸 태그 위치(`hwpcraft:goto`)로 이동한다 — 순수 로직만 둔다(DOM·wasm 의존 없음).
 *
 * 센 방법은 부모의 태그 검사와 같아야 한다: 글자는 문단 자기 글자 기준, 대소문자 구분,
 * 문단 안에서 왼쪽부터 겹치지 않게. 순서는 rhwp `searchAllText` 가 주는 순서(구역 → 문단마다
 * 자기 글자 먼저, 그 다음 그 문단의 표 셀·글상자를 깊이 우선)를 그대로 따른다.
 * 본문·표 셀·글상자 안 본문만 'body' 로 센다. 머리말·꼬리말·각주·미주는 찾기가 훑지 않으므로 unsupported.
 */

export type GotoFailReason = 'not-found' | 'unsupported' | 'error';
export type GotoOutcome = { ok: true } | { ok: false; reason: GotoFailReason };

/** 찾을 글자 상한(바이트). wordcraft 와 같다. */
export const GOTO_MAX_TEXT_BYTES = 4000;
/** occurrence·total 상한. wordcraft 와 같다. */
export const GOTO_MAX_COUNT = 1_000_000;

/** `searchAllText` 가 주는 한 건 중 이동에 쓰는 부분. */
export interface GotoHit {
  sec: number;
  para: number;
  charOffset: number;
  length: number;
  cellContext?: { parentPara: number; ctrlIdx: number; cellIdx: number; cellPara: number };
  /** 중첩 표·글상자 깊이 2 이상일 때만 실린다(cellContext 대신). */
  cellPath?: unknown[];
  /** 수식 스크립트 안 일치 — 문단 글자가 아니므로 세지 않는다. */
  equationControl?: number;
}

export interface GotoDeps {
  /** 문서 전체에서 text 의 일치를 문서 순서로 돌려준다(대소문자 구분, 표 셀 포함). */
  findHits(text: string): GotoHit[];
  /** (구역, 문단, 컨트롤) 이 표인지. 글상자 일치도 cellContext 로 오므로 표와 구별해야 한다. */
  isTable(sec: number, parentPara: number, ctrlIdx: number): boolean;
  /** 일치를 선택하고 화면을 그 자리로 옮긴다. */
  select(hit: GotoHit): boolean;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= GOTO_MAX_COUNT;

const STORIES = ['body', 'header', 'footer', 'footnote', 'endnote'];

/** location 을 검사해 이동한다. 모양이 틀리면 error, 못 다루는 종류·범위는 unsupported. */
export function gotoLocation(location: unknown, deps: GotoDeps): GotoOutcome {
  if (typeof location !== 'object' || location === null) return { ok: false, reason: 'error' };
  const loc = location as Record<string, unknown>;
  // xlsx·docx·pptx 위치는 이 편집기가 다루지 않는다.
  if (loc.kind !== 'hwpx') return { ok: false, reason: 'unsupported' };
  const { story, text, occurrence, total } = loc;
  if (typeof story !== 'string' || !STORIES.includes(story)) return { ok: false, reason: 'error' };
  if (typeof text !== 'string' || text.length === 0 || new TextEncoder().encode(text).length > GOTO_MAX_TEXT_BYTES) {
    return { ok: false, reason: 'error' };
  }
  if (!isCount(occurrence) || !isCount(total)) return { ok: false, reason: 'error' };
  // 찾기는 본문·표 셀·글상자만 훑는다.
  if (story !== 'body') return { ok: false, reason: 'unsupported' };

  let hits: GotoHit[];
  try {
    hits = deps.findHits(text).filter((h) => h.equationControl === undefined);
  } catch (e) {
    console.error('[hwpcraft] goto 찾기 실패', e);
    return { ok: false, reason: 'error' };
  }
  // 부모가 센 수와 다르면 문서가 바뀐 것이다 — 엉뚱한 곳을 고르지 않는다.
  if (hits.length !== total || occurrence > hits.length) return { ok: false, reason: 'not-found' };
  const hit = hits[occurrence - 1]!;

  // 중첩 표: 찾기 이동이 cellPath 를 받지 못해 본문 좌표로 떨어진다(바깥 문단을 가리킨다).
  if (hit.cellPath !== undefined && hit.cellContext === undefined) return { ok: false, reason: 'unsupported' };
  if (hit.cellContext) {
    // 글상자 일치는 표와 같은 모양으로 온다. 글상자 안으로는 옮기지 않는다.
    let table = false;
    try {
      table = deps.isTable(hit.sec, hit.cellContext.parentPara, hit.cellContext.ctrlIdx);
    } catch {
      table = false;
    }
    if (!table) return { ok: false, reason: 'unsupported' };
  }
  try {
    return deps.select(hit) ? { ok: true } : { ok: false, reason: 'error' };
  } catch (e) {
    console.error('[hwpcraft] goto 선택 실패', e);
    return { ok: false, reason: 'error' };
  }
}
