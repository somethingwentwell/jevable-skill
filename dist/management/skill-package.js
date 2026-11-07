import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { readBoundedBytes } from "../files.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { zipEpoch } from "../packages/zip-time.js";
import { createManagementFiles } from "./package.js";
import { AGENT_SKILL_RESOURCES } from "./skill-resources.js";
export { AGENT_SKILL_RESOURCES } from "./skill-resources.js";
export const AGENT_SKILL_PACKAGE_LIMITS = Object.freeze({ resourceBytes: 4_000_000, totalBytes: 64_000_000 });
const digest = (value) => createHash('sha256').update(value).digest('hex');
const root = fileURLToPath(new URL('../../', import.meta.url));
/** Package-owned assets only, including ancestors; never follow a linked resource or fall back. */
async function readOwnedAsset(path, limit) {
    const ownedRoot = await realpath(root), selected = relative(root, path);
    if (!selected || selected.startsWith('..' + sep) || selected === '..' || resolve(root, selected) !== resolve(path))
        throw new WorkflowRuntimeError('corrupt');
    let current = ownedRoot;
    for (const part of selected.split(sep)) {
        current = resolve(current, part);
        if ((await lstat(current)).isSymbolicLink())
            throw new WorkflowRuntimeError('corrupt');
    }
    if (!(await lstat(current)).isFile() || await realpath(current) !== current)
        throw new WorkflowRuntimeError('corrupt');
    return readBoundedBytes(current, limit);
}
/** Offline distributable agent instructions plus the owned CLI; not a workflow release or image.
 * The optional reader is trusted SDK dependency injection, not an untrusted path/configuration input.
 */
export async function createAgentSkillZip(readBytes = readOwnedAsset, options = {}) {
    const management = await createManagementFiles(readBytes, options);
    const files = management.files;
    files['runtime-manifest.json'] = files['manifest.json'];
    delete files['manifest.json'];
    let total = Object.values(files).reduce((sum, value) => sum + value.byteLength, 0);
    for (const name of AGENT_SKILL_RESOURCES) {
        const value = await readBytes(resolve(root, name), AGENT_SKILL_PACKAGE_LIMITS.resourceBytes);
        if (!value.byteLength || value.byteLength > AGENT_SKILL_PACKAGE_LIMITS.resourceBytes)
            throw new WorkflowRuntimeError('limit');
        total += value.byteLength;
        if (total > AGENT_SKILL_PACKAGE_LIMITS.totalBytes)
            throw new WorkflowRuntimeError('limit');
        files[name] = value;
    }
    const manifest = { schemaVersion: management.manifest.schemaVersion,
        ...('rateCoordinator' in management.manifest ? { rateCoordinator: management.manifest.rateCoordinator } : {}), format: 'jevable.ai/agent-skill-zip', version: management.manifest.version,
        root: 'jevable', skill: { name: 'jevable', instructions: 'SKILL.md' }, entrypoint: 'bin/jevable.mjs',
        requires: management.manifest.requires, runtimes: management.manifest.runtimes,
        runtimeManifest: 'runtime-manifest.json',
        files: Object.keys(files).sort().map(path => ({ path, bytes: files[path].byteLength, sha256: digest(files[path]) })),
        state: 'excluded', credentials: 'excluded', developerArtifacts: 'excluded', installation: 'not-performed',
        authenticity: 'checksums-only; not-signed', execution: 'not-started-by-export' };
    files['manifest.json'] = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    if (total + files['manifest.json'].byteLength > AGENT_SKILL_PACKAGE_LIMITS.totalBytes)
        throw new WorkflowRuntimeError('limit');
    return { bytes: Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, bytes]) => ['jevable/' + name, bytes])), { level: 6, mtime: zipEpoch() })), manifest };
}
