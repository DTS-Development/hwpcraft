import { isCommandAllowed, type CommandOverrides } from './command-policy.ts';

/** 외부 링크(웹·메일·파일·앱) 열기 스위치 `link.external` 이 꺼져 있으면 true. */
export function isExternalLinkBlockedBy(overrides: CommandOverrides): boolean {
  return !isCommandAllowed('link.external', overrides);
}
