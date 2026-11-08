// RECONSTRUCTION. The original script is not in the public repository, and no copy was found.
// It is rebuilt from how 17 test files use it, and may differ from the original (key type, validity
// period, subject/SAN details and the meaning of the optional second argument are inferred).
//
// Test-only TLS material. Requires an OpenSSL CLI that supports `req -addext` (see
// references/development.md); it is not a runtime prerequisite. Keys stay in the caller's
// temporary directory.
//
// createTlsFixture(directory, hosts?, commonName?) creates ONE self-signed certificate that is
// also its own trust anchor:
//   cert - path to the certificate PEM file (also usable as a --ca-file)
//   key  - path to its private key (owner-only, 0600)
//   ca   - the certificate PEM text (equal to the contents of `cert`)
// Each call uses fresh file names, so two fixtures in one directory never share a key.
// fixturePort() returns a currently free loopback TCP port.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const DEFAULT_HOSTS = ['127.0.0.1', '::1', 'localhost']

export async function createTlsFixture(directory, hosts = DEFAULT_HOSTS, commonName = 'jevable-test-localhost') {
  const stem = join(directory, `tls-fixture-${randomUUID()}`)
  const cert = `${stem}.crt`, key = `${stem}.key`
  const san = hosts.map(host => (/^[\d.]+$/.test(host) || host.includes(':') ? `IP:${host}` : `DNS:${host}`)).join(',')
  await run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-sha256',
    '-days', '2', '-subj', `/CN=${commonName}`, '-addext', `subjectAltName=${san}`,
    '-addext', 'keyUsage=critical,digitalSignature,keyCertSign',
    '-addext', 'extendedKeyUsage=serverAuth,clientAuth',
    '-keyout', key, '-out', cert], { timeout: 20_000 })
  await chmod(key, 0o600); await chmod(cert, 0o600)
  return { cert, key, ca: await readFile(cert, 'utf8') }
}

export function fixturePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(error => (error ? reject(error) : resolve(port)))
    })
  })
}
