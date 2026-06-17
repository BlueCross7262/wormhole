// picomatch 최소 타입 선언 — @types/picomatch 미설치 환경 대비.
// 사용 범위: 단일 패턴(또는 배열) → matcher 함수 생성.
declare module "picomatch" {
  interface PicomatchOptions {
    dot?: boolean;
    nocase?: boolean;
    [key: string]: unknown;
  }
  type Matcher = (str: string) => boolean;
  function picomatch(
    glob: string | string[],
    options?: PicomatchOptions,
  ): Matcher;
  export = picomatch;
}
