/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __RHWP_DISABLE_EXTERNAL_WEBFONTS__: boolean;
/** hwpctrl 플러그인을 이 빌드에 포함하는가 (`RHWP_WITHOUT_HWPCTRL=1` 이면 false). */
declare const __RHWP_HWPCTRL__: boolean;
/** AI 도우미 플러그인을 이 빌드에 포함하는가 (`RHWP_WITHOUT_AI=1` 이면 false). */
declare const __RHWP_AI__: boolean;
/** PPM 호스트 모드 빌드인가 (`RHWP_PPM_HOST=1`). 문서 출입을 부모가 맡는다. */
declare const __RHWP_PPM_HOST__: boolean;
