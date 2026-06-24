declare module "micromatch" {
  const micromatch: {
    isMatch: (str: string, patterns: string[], options?: object) => boolean;
  };
  export default micromatch;
}
