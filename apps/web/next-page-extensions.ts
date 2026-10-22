/** `route.e2e.ts` is a route only in an e2e build (MTXT_E2E_BUILD=1). See lib/auth/test-sign-in.ts. */
export const pageExtensions = (e2eBuild: string | undefined) =>
  e2eBuild === '1' ? ['tsx', 'ts', 'e2e.ts'] : ['tsx', 'ts'];
