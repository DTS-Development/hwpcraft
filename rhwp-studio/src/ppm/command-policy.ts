/**
 * PPM host 모드 명령 정책 — "문서 자체의 출입(열기·저장·인쇄·외부 링크)"만 막는다.
 * 문서 안 편집 명령은 모두 기본 on 이다.
 *
 * 등급: locked(정책으로도 못 켬) / off(기본 꺼짐, override true 로 켬) / on(기본 켜짐, override false 로 끔).
 * 표에 없는 id 는 on. 순수 모듈(DOM·wasm 의존 없음)이라 node 테스트로 직접 검증한다.
 */

export type CommandGrade = 'locked' | 'off' | 'on';

/** on 이 아닌 것만 적는다. 나머지는 기본 on. 가짜 id `link.external` 은 외부 링크 열기 스위치. */
export const NON_DEFAULT_GRADES: Readonly<Record<string, CommandGrade>> = {
  'file:new-doc': 'locked',
  'file:open': 'locked',
  'file:open-recent': 'locked',
  'file:clear-recent': 'locked',
  'file:save-as': 'off',
  'file:save-as-hwp': 'off',
  'file:save-as-hwpx': 'off',
  'file:export-html': 'off',
  'file:export-doc': 'off',
  'file:print-to-pdf': 'off',
  'file:print': 'off',
  'link.external': 'off',
};

/** 열기·새 문서·최근 문서처럼 정책으로도 켤 수 없는 명령(편집기에 등록하지 않는다). */
export const LOCKED_COMMAND_IDS: readonly string[] = Object.entries(NON_DEFAULT_GRADES)
  .filter(([, grade]) => grade === 'locked')
  .map(([id]) => id);

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_OVERRIDES = 2000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type CommandOverrides = Readonly<Record<string, boolean>>;

/** 부모가 보낸 overrides 를 정리한다. 형식에 안 맞는 id·boolean 이 아닌 값은 버린다. */
export function sanitizeOverrides(input: unknown): CommandOverrides {
  const out: Record<string, boolean> = Object.create(null);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  let count = 0;
  for (const [id, value] of Object.entries(input as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(id) || !ID_PATTERN.test(id)) continue;
    if (typeof value !== 'boolean') continue;
    if (++count > MAX_OVERRIDES) break;
    out[id] = value;
  }
  return out;
}

export function gradeOf(id: string): CommandGrade {
  return Object.prototype.hasOwnProperty.call(NON_DEFAULT_GRADES, id) ? NON_DEFAULT_GRADES[id] : 'on';
}

/** 등급과 override 로 명령이 허용되는지 계산한다. locked 는 override 와 무관하게 막힌다. */
export function isCommandAllowed(id: string, overrides: CommandOverrides): boolean {
  const grade = gradeOf(id);
  if (grade === 'locked') return false;
  const override = Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : undefined;
  if (override !== undefined) return override;
  return grade === 'on';
}

/** 현재 정책에서 막힌 id 목록(표에 있는 것 + override 로 끈 것). DOM 숨김용. */
export function blockedIds(overrides: CommandOverrides, knownIds: Iterable<string>): string[] {
  const out: string[] = [];
  for (const id of knownIds) if (!isCommandAllowed(id, overrides)) out.push(id);
  return out;
}
