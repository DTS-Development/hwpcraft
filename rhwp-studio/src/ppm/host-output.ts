/**
 * PPM host 모드: 정책으로 켠 다른 형식 저장·내보내기를 사용자 PC 내려받기 대신 부모의 save 이벤트로 넘긴다.
 * 문서의 출입은 부모가 소유한다(메뉴 막기 원칙). 파일 명령 코드는 이 보관소만 알고 브리지는 모른다.
 */
export type HostOutputFormat = 'hwp' | 'hwpx' | 'hml' | 'html' | 'doc';

export interface HostOutputFile { name: string; bytes: Uint8Array; format: HostOutputFormat }

type HostOutputSink = (file: HostOutputFile) => void | Promise<void>;

let sink: HostOutputSink | null = null;

export function setHostOutput(next: HostOutputSink | null): void { sink = next; }

/** 부모로 넘긴다. 연결 전이면 던져서 명령이 오류를 알리게 한다. */
export async function sendHostOutput(file: HostOutputFile): Promise<void> {
  if (!sink) throw new Error('부모 창과 연결되지 않아 내보낼 수 없습니다');
  await sink(file);
}
