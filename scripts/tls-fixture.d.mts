// Types for the reconstructed scripts/tls-fixture.mjs (see that file's header).
export interface TlsFixture {
  /** Path to the self-signed certificate PEM file; also usable as a CA file. */
  cert: string
  /** Path to the certificate's private key (mode 0600). */
  key: string
  /** Certificate PEM text, identical to the contents of `cert`. */
  ca: string
}
export function createTlsFixture(directory: string, hosts?: readonly string[], commonName?: string): Promise<TlsFixture>
export function fixturePort(): Promise<number>
