/** Standalone Node scripts mounted by the generated workload; no core/skill installation needed. */
export const stageConfiguration = `import { realpath, open, mkdir, chmod, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, sep } from 'node:path';
const [source, destination, telemetry, extraCa, podMetadata = 'no'] = process.argv.slice(2);
try {
  if (!['yes','no'].includes(podMetadata) || (podMetadata === 'yes' && telemetry !== 'yes')) throw Error();
  const root = await realpath(source);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await chmod(destination, 0o700);
  const names = ['database.json','service-token','server.crt','server.key','ca.crt',
    ...(telemetry === 'yes' ? ['telemetry.json'] : []), ...(extraCa === 'yes' ? ['telemetry-ca.crt'] : [])];
  for (const name of names) {
    // Kubernetes Secret projections deliberately use symlinks. Resolve only inside this volume,
    // then open the target without following a final symlink or blocking on a FIFO.
    const target = await realpath(resolve(root, name));
    if (!target.startsWith(root + sep)) throw Error();
    const input = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes;
    try {
      const stat = await input.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 1000000) throw Error();
      bytes = Buffer.alloc(stat.size + 1); let length = 0;
      while (length < bytes.length) { const r = await input.read(bytes, length, bytes.length-length, null); if (!r.bytesRead) break; length += r.bytesRead; }
      if (length !== stat.size) throw Error(); bytes = bytes.subarray(0,length);
    } finally { await input.close(); }
    if (name === 'database.json' && JSON.parse(bytes.toString('utf8')).tls?.mode !== 'verify-full') throw Error();
    if (name === 'telemetry.json' && podMetadata === 'yes') {
      const config = JSON.parse(bytes.toString('utf8'));
      const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
      if (!object(config) || (config.resource !== undefined && !object(config.resource))) throw Error();
      const resource = config.resource ?? {}, existing = resource.kubernetes === undefined ? {} : resource.kubernetes;
      if (!object(existing)) throw Error();
      const identity = { namespace: process.env.JEVABLE_K8S_NAMESPACE, podName: process.env.JEVABLE_K8S_POD_NAME,
        podUid: process.env.JEVABLE_K8S_POD_UID, nodeName: process.env.JEVABLE_K8S_NODE_NAME, containerName: 'workflow' };
      for (const [key, value] of Object.entries(identity)) {
        const valid = typeof value === 'string' && (key === 'podUid'
          ? /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
          : value.length <= (key === 'namespace' || key === 'containerName' ? 63 : 253)
            && (key === 'namespace' || key === 'containerName' ? /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/ : /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/).test(value));
        if (!valid || (existing[key] !== undefined && existing[key] !== value)) throw Error();
      }
      // No arbitrary environment, labels, annotations or service.instance.id overrides.
      config.resource = { ...resource, kubernetes: { ...existing, ...identity } };
      bytes = Buffer.from(JSON.stringify(config));
      if (bytes.length > 1000000) throw Error();
    }
    const pending = resolve(destination, name + '.pending');
    // An init-container retry may replace its own incomplete private files; application is not running yet.
    const output = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | (constants.O_NOCTTY ?? 0), 0o600);
    try {
      // Refuse special/shared files before truncation or chmod; retries replace only our regular pending inode.
      const stat = await output.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw Error();
      await output.truncate(0); await output.chmod(0o600); await output.writeFile(bytes); await output.sync();
    } finally { await output.close(); }
    await rename(pending, resolve(destination, name));
  }
} catch { process.stderr.write('Jevable private configuration staging failed.\\n'); process.exitCode = 1; }
`;

export const readinessProbe = `import { request } from 'node:https';
import { readFile } from 'node:fs/promises';
import { checkServerIdentity } from 'node:tls';
const [origin, releaseId, releaseHash, runtimeHash, protocol, directory, port = '8787'] = process.argv.slice(2);
try {
  const url = new URL(origin), token = (await readFile(directory + '/service-token','utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error();
  const ca = await readFile(directory + '/ca.crt');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { outgoing.destroy(); reject(Error()); }, 2000);
    const outgoing = request({ hostname: '127.0.0.1', port: Number(port), path: '/v1/health', method: 'GET',
      servername: url.hostname, checkServerIdentity: (_, certificate) => checkServerIdentity(url.hostname, certificate),
      ca, rejectUnauthorized: true, minVersion: 'TLSv1.2', agent: false, maxHeaderSize: 16384,
      headers: { host: url.host, authorization: 'Bearer ' + token, 'x-jevable-protocol': protocol } }, response => {
        let bytes = 0; const chunks = [];
        response.on('data', chunk => { bytes += chunk.length; if (bytes > 64000) response.destroy(Error()); else chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks));
            if (response.statusCode !== 200 || response.headers['x-jevable-protocol'] !== protocol
              || body.status !== 'ready' || body.release?.id !== releaseId || body.release?.sha256 !== releaseHash
              || body.release?.runtime?.sha256 !== runtimeHash || body.runtime?.storage !== 'postgres'
              || body.runtime?.database !== 'reachable') throw Error();
            resolve();
          } catch { reject(Error()); }
        });
      });
    outgoing.on('error', reject); outgoing.on('close', () => clearTimeout(timer)); outgoing.end();
  });
} catch { process.stderr.write('Jevable release readiness failed.\\n'); process.exitCode = 1; }
`;

/** Keep the existing disabled script unchanged; opt-in copies additional projected files with its same bounded inode checks. */
export function notificationStageConfiguration(extraCa: boolean) {
  if (typeof extraCa !== 'boolean') throw Error('Jevable notification staging option refused.')
  const needle = "...(extraCa === 'yes' ? ['telemetry-ca.crt'] : [])];"
  if (stageConfiguration.indexOf(needle) < 0 || stageConfiguration.indexOf(needle) !== stageConfiguration.lastIndexOf(needle)) {
    throw Error('Jevable private staging template mismatch.')
  }
  const program = stageConfiguration.replace(needle, "...(extraCa === 'yes' ? ['telemetry-ca.crt'] : []), 'notifications.json'" +
    (extraCa ? ", 'notifications-ca.crt'" : '') + '];')
  if (!extraCa) return program
  const check = "    if (name === 'database.json'"
  if (program.indexOf(check) < 0 || program.indexOf(check) !== program.lastIndexOf(check)) throw Error('Jevable private staging template mismatch.')
  return "import { X509Certificate } from 'node:crypto';\n" + certificateBundleCheck + program.replace(check,
    "    if (name === 'notifications-ca.crt') certificateBundle(bytes);\n" + check)
}

/** Explicit quota attachment keeps the disabled projection unchanged; full options remain runtime-validated. */
export function rateCoordinatorStageConfiguration(stage: string) {
  if (typeof stage !== 'string') throw Error('Jevable quota staging option refused.')
  const changes = [
    ["const names = ['database.json','service-token'", "const names = ['database.json','rate-coordinator.json','service-token'"],
    ['      const stat = await input.stat();', "      const stat = await input.stat();\n      if (name === 'rate-coordinator.json' && stat.size > 65536) throw Error();"],
    ["    if (name === 'database.json'", `    if (name === 'rate-coordinator.json') {
      const quota = JSON.parse(bytes.toString('utf8'));
      if (!quota || typeof quota !== 'object' || Array.isArray(quota)
        || quota.initialize !== false || quota.connection?.tls?.mode !== 'verify-full') throw Error();
    }
    if (name === 'database.json'`],
  ] as const
  let program = stage
  for (const [before, after] of changes) {
    if (program.indexOf(before) < 0 || program.indexOf(before) !== program.lastIndexOf(before)) {
      throw Error('Jevable private staging template mismatch.')
    }
    program = program.replace(before, after)
  }
  return program
}

const certificateBundleCheck = `function certificateBundle(bytes) {
  const text = bytes.toString('utf8'), blocks = text.match(/-----BEGIN CERTIFICATE-----[\\s\\S]*?-----END CERTIFICATE-----/g);
  if (!blocks || blocks.length > 32 || text.replace(/-----BEGIN CERTIFICATE-----[\\s\\S]*?-----END CERTIFICATE-----/g, '').trim()) throw Error();
  for (const block of blocks) new X509Certificate(block);
}
`;

/** Node has one extra-CA file. Combine two explicitly staged trust inputs without disabling certificate verification. */
export const combineOutboundCa = `import { open, rename, realpath, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { X509Certificate } from 'node:crypto';
${certificateBundleCheck}
const [directory] = process.argv.slice(2);
try {
  if (process.argv.length !== 3 || typeof directory !== 'string' || await realpath(directory) !== directory) throw Error();
  const folder = await lstat(directory);
  if (!folder.isDirectory() || folder.isSymbolicLink() || folder.uid !== process.getuid() || (folder.mode & 511) !== 448) throw Error();
  const parts = [];
  for (const name of ['telemetry-ca.crt', 'notifications-ca.crt']) {
    const input = await open(directory + '/' + name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await input.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 511) !== 384 || stat.size < 1 || stat.size > 1000000) throw Error();
      const bytes = Buffer.alloc(stat.size + 1); let length = 0;
      while (length < bytes.length) { const r = await input.read(bytes, length, bytes.length - length, null); if (!r.bytesRead) break; length += r.bytesRead; }
      if (length !== stat.size) throw Error();
      certificateBundle(bytes.subarray(0, length));
      parts.push(bytes.subarray(0, length), Buffer.from('\\n'));
    } finally { await input.close(); }
  }
  const pending = directory + '/outbound-ca.crt.pending';
  const output = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | (constants.O_NOCTTY ?? 0), 384);
  try {
    const stat = await output.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()) throw Error();
    await output.truncate(0); await output.chmod(384); await output.writeFile(Buffer.concat(parts)); await output.sync();
  } finally { await output.close(); }
  await rename(pending, directory + '/outbound-ca.crt');
} catch { process.stderr.write('Jevable outbound trust staging failed.\\n'); process.exitCode = 1; }
`;
