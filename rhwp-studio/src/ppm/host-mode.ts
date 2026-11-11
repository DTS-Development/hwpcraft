/**
 * PPM 호스트 모드 판정.
 *
 * `RHWP_PPM_HOST=1`로 빌드한 PPM용 번들(`ppm/build-web.sh`)은 컴파일 시점에 항상 호스트 모드다.
 * 같은 출처 부모 창(`?host=parent`)과 연결되지 않으면 문서를 열지 않고 안내 화면만 보인다.
 * 업스트림 빌드(`RHWP_PPM_HOST` 없음)는 이 모듈의 어떤 값도 동작을 바꾸지 않는다.
 * 계약: ppm docs/alternate/hostlock-contract.md
 */

declare const __RHWP_PPM_HOST__: boolean;

/** 이 빌드가 PPM 호스트 모드인가. 컴파일 시점 상수라 업스트림 빌드에서는 관련 분기가 모두 제거된다. */
export const PPM_HOST: boolean = typeof __RHWP_PPM_HOST__ !== 'undefined' && __RHWP_PPM_HOST__ === true;

/** host 빌드 표식. 번들에 이 문자열이 없으면 ppm/build-web.sh 가 실패한다(host 모드가 소리 없이 꺼지는 사고 방지). */
export const PPM_HOST_MARKER = 'hwpcraft-ppm-host-build';

export interface HostConnectionInput {
  search: string;
  /** window.parent !== window */
  framed: boolean;
}

/** 부모 창과 연결됐는지. 같은 출처 검사는 메시지를 받을 때 한다(host-bridge). */
export function isHostConnected(input: HostConnectionInput): boolean {
  return input.framed && new URLSearchParams(input.search).get('host') === 'parent';
}
