/** Credential-free pre-start gate, not a database/role/schema health check or runtime retry. */
export const databaseTransportGate = `import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { connect, isIP } from 'node:net';
import { connect as secureConnect, checkServerIdentity, createSecureContext } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
const [file, seconds, ...extra] = process.argv.slice(2);
let failure = 'configuration-invalid';
try {
  if (extra.length || !/^[1-9][0-9]{0,2}$/.test(seconds ?? '') || Number(seconds) > 300) throw Error();
  const input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let config;
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 1000000
      || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) throw Error();
    const bytes = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < bytes.length) { const r = await input.read(bytes,length,bytes.length-length,null); if (!r.bytesRead) break; length += r.bytesRead; }
    if (length !== stat.size) throw Error();
    config = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length)));
  } finally { await input.close(); }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || typeof config.host !== 'string' || config.host.length > 253
    || (!isIP(config.host) && !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(config.host))
    || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535
    || config.tls?.mode !== 'verify-full') throw Error();
  const ca = config.tls.ca;
  if (ca !== undefined) {
    if (typeof ca !== 'string' || Buffer.byteLength(ca) > 262144) throw Error();
    const certs = ca.match(/-----BEGIN CERTIFICATE-----[\\s\\S]*?-----END CERTIFICATE-----/g);
    if (!certs?.length || ca.replace(/-----BEGIN CERTIFICATE-----[\\s\\S]*?-----END CERTIFICATE-----/g,'').trim()) throw Error();
    for (const cert of certs) new X509Certificate(cert);
  }
  createSecureContext({ca,minVersion:'TLSv1.2'});
  const transient = new Set(['ECONNREFUSED','ECONNRESET','ENOTFOUND','EAI_AGAIN','ETIMEDOUT']);
  const deadline = performance.now() + Number(seconds) * 1000;
  async function probe(milliseconds) {
    return new Promise((resolve,reject) => {
      let secure, settled = false;
      const socket = connect({host:config.host,port:config.port});
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); secure?.destroy(); socket.destroy(); error ? reject(error) : resolve(); };
      const error = code => Object.assign(Error(),{code});
      const timer = setTimeout(()=>finish(error('ETIMEDOUT')),milliseconds);
      socket.on('error',finish);
      socket.once('end',()=>finish(error('ECONNRESET')));
      socket.once('connect',()=>{ const request = Buffer.alloc(8); request.writeInt32BE(8,0); request.writeInt32BE(80877103,4); socket.write(request); });
      socket.once('data',bytes=>{
        // PostgreSQL SSLRequest response is exactly one S byte. Never consume untrusted error text
        // or downgrade to plaintext. Refuse extra buffered bytes before giving the socket to TLS.
        if (bytes.length !== 1 || bytes[0] !== 83 || socket.readableLength !== 0) return finish(error('PROTOCOL_REFUSED'));
        try {
          secure = secureConnect({socket,ca,rejectUnauthorized:true,minVersion:'TLSv1.2',
            ...(isIP(config.host) ? {} : {servername:config.host}),
            checkServerIdentity:(_,cert)=>checkServerIdentity(config.host,cert)},()=>finish(performance.now() >= deadline ? error('ETIMEDOUT') : undefined));
          secure.on('error',finish);
        } catch { finish(error('TLS_REFUSED')); }
      });
    });
  }
  failure = 'transport-unavailable';
  while (true) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) { failure = 'deadline'; throw Error(); }
    try { await probe(Math.max(1,Math.min(2000,Math.ceil(remaining)))); break; }
    catch (error) {
      if (!transient.has(error.code)) { failure = error.code === 'PROTOCOL_REFUSED' ? 'protocol-refused' : 'tls-refused'; throw Error(); }
      await delay(Math.max(0,Math.min(500,deadline-performance.now())));
    }
  }
  // No StartupMessage, authentication, SQL, journal ownership, schema creation or workflow dispatch.
  process.stdout.write(JSON.stringify({status:'ready',check:'postgresql-tls-transport',authentication:'not-checked',execution:'not-run'})+'\\n');
} catch {
  process.stderr.write(JSON.stringify({status:'not-ready',check:'postgresql-tls-transport',code:failure})+'\\n');
  process.exitCode = 1;
}
`;
