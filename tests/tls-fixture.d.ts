// scripts/tls-fixture.mjs is a test-support script that is not in the public repository.
// Like tests/provider-trace-fixture.d.ts, this ambient declaration lets `npm run typecheck`
// succeed without it. Its real signatures are unavailable, so the results are typed loosely
// rather than guessed. vitest.config.ts skips the test files that need the script when it is absent.
declare module '*tls-fixture.mjs' {
  export function createTlsFixture(directory: string, ...options: any[]): Promise<any>
  export function fixturePort(): Promise<any>
}
