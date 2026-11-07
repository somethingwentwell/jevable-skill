import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CORE_VERSION } from "../capabilities.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { readBoundedZip, BoundedZipError } from "../packages/read-zip.js";
import { MANAGEMENT_PACKAGE_FILES, MANAGEMENT_COORDINATED_PACKAGE_FILES } from "./package.js";
import { AGENT_SKILL_RESOURCES } from "./skill-resources.js";
import { AGENT_SKILL_PACKAGE_LIMITS } from "./skill-package.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const paths = [...MANAGEMENT_PACKAGE_FILES, ...AGENT_SKILL_RESOURCES, 'runtime-manifest.json'];
const coordinatedPaths = [...MANAGEMENT_COORDINATED_PACKAGE_FILES, ...AGENT_SKILL_RESOURCES, 'runtime-manifest.json'];
const archivePaths = new Set([...coordinatedPaths, 'manifest.json'].map(path => 'jevable/' + path));
export const AGENT_SKILL_INSPECTION_LIMITS = Object.freeze({ archiveBytes: 65_000_000,
    entryBytes: 32_000_000, totalBytes: AGENT_SKILL_PACKAGE_LIMITS.totalBytes, entries: archivePaths.size });
const requires = z.strictObject({ node: z.literal('>=22.19.0'), sqlite: z.literal('builtin'), npmInstall: z.literal(false), docker: z.literal(false) });
const runtimeIdentity = z.strictObject({ role: z.enum(['management', 'sqlite', 'postgres', 'sqlite-coordinated']), sha256: hash,
    bytes: z.number().int().positive().max(AGENT_SKILL_INSPECTION_LIMITS.entryBytes) });
const identities = z.array(runtimeIdentity).length(3);
const fileIdentity = z.strictObject({ path: z.string().min(1).max(256), bytes: z.number().int().positive().max(AGENT_SKILL_INSPECTION_LIMITS.entryBytes), sha256: hash });
const shared = { schemaVersion: z.literal(1), version: z.literal(CORE_VERSION), entrypoint: z.literal('bin/jevable.mjs'),
    requires, runtimes: identities, state: z.literal('excluded'), credentials: z.literal('excluded'),
    authenticity: z.literal('checksums-only; not-signed'), execution: z.literal('not-started-by-export') };
const coordinatedShared = { ...shared, schemaVersion: z.literal(2), rateCoordinator: z.literal('postgres'), runtimes: z.array(runtimeIdentity).length(4) };
const outerFields = { format: z.literal('jevable.ai/agent-skill-zip'), root: z.literal('jevable'),
    skill: z.strictObject({ name: z.literal('jevable'), instructions: z.literal('SKILL.md') }), runtimeManifest: z.literal('runtime-manifest.json'),
    developerArtifacts: z.literal('excluded'), installation: z.literal('not-performed') };
const outerSchema = z.discriminatedUnion('schemaVersion', [
    z.strictObject({ ...shared, ...outerFields, files: z.array(fileIdentity).length(paths.length) }),
    z.strictObject({ ...coordinatedShared, ...outerFields, files: z.array(fileIdentity).length(coordinatedPaths.length) }),
]);
const innerSchema = z.discriminatedUnion('schemaVersion', [
    z.strictObject({ ...shared, format: z.literal('jevable.ai/management-zip'), files: z.array(fileIdentity).length(MANAGEMENT_PACKAGE_FILES.length) }),
    z.strictObject({ ...coordinatedShared, format: z.literal('jevable.ai/management-zip'), files: z.array(fileIdentity).length(MANAGEMENT_COORDINATED_PACKAGE_FILES.length) }),
]);
const metadataSchema = z.object({ schemaVersion: z.literal(1), storage: z.enum(['management', 'sqlite', 'postgres']),
    external: z.literal('node-builtins-only'), bytes: runtimeIdentity.shape.bytes, sha256: hash, coreVersion: z.string().optional(), rateCoordinator: z.literal('postgres').optional() });
const digest = (b) => createHash('sha256').update(b).digest('hex');
const fail = (code = 'corrupt') => { throw new WorkflowRuntimeError(code); };
/** Bounded offline consistency inspection. Never extract, import code, open state or authenticate a publisher. */
export async function inspectAgentSkillZip(input, expectedSha256) {
    if (!(input instanceof Uint8Array) || expectedSha256 !== undefined && !hash.safeParse(expectedSha256).success)
        return fail('invalid-command');
    if (input.byteLength > AGENT_SKILL_INSPECTION_LIMITS.archiveBytes)
        return fail('limit');
    const bytes = Buffer.from(input), archiveSha256 = digest(bytes);
    if (expectedSha256 !== undefined && expectedSha256 !== archiveSha256)
        return fail('conflict');
    try {
        const entries = await readBoundedZip(bytes, AGENT_SKILL_INSPECTION_LIMITS, path => archivePaths.has(path));
        const get = (path) => { const b = entries.get('jevable/' + path); if (!b)
            return fail(); return b; };
        const readJson = (path) => {
            const b = get(path);
            if (b.length > 1_000_000)
                return fail('limit');
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b));
        };
        const outer = outerSchema.parse(readJson('manifest.json')), inner = innerSchema.parse(readJson('runtime-manifest.json'));
        const coordinated = outer.schemaVersion === 2;
        if (inner.schemaVersion !== outer.schemaVersion)
            return fail();
        const expected = new Set(coordinated ? coordinatedPaths : paths);
        if (entries.size !== expected.size + 1 || [...entries.keys()].some(path => path !== 'jevable/manifest.json' && !expected.has(path.slice('jevable/'.length))))
            return fail();
        const checkFiles = (files, allowed) => {
            if (files.length !== allowed.size || new Set(files.map(f => f.path)).size !== files.length)
                return fail();
            for (const f of files) {
                if (!allowed.has(f.path))
                    return fail();
                const b = get(f.path);
                if (b.length !== f.bytes || digest(b) !== f.sha256)
                    return fail();
            }
        };
        checkFiles(outer.files, expected);
        checkFiles(inner.files, new Set(coordinated ? MANAGEMENT_COORDINATED_PACKAGE_FILES : MANAGEMENT_PACKAGE_FILES));
        if (!isDeepStrictEqual(outer.runtimes, inner.runtimes) || !isDeepStrictEqual(outer.requires, inner.requires))
            return fail();
        if (!isDeepStrictEqual(outer.runtimes.map(r => r.role), ['management', 'sqlite', 'postgres', ...(coordinated ? ['sqlite-coordinated'] : [])]))
            return fail();
        for (const name of AGENT_SKILL_RESOURCES)
            if (get(name).length > AGENT_SKILL_PACKAGE_LIMITS.resourceBytes)
                return fail('limit');
        for (const [index, stem] of ['dist/management/core', 'dist/release', 'dist/release-postgres', ...(coordinated ? ['dist/release-sqlite-coordinated'] : [])].entries()) {
            const identity = outer.runtimes[index], metadata = metadataSchema.parse(readJson(stem + '-runtime.json'));
            const program = get(stem + '-runtime.mjs');
            if (metadata.storage !== (identity.role === 'sqlite-coordinated' ? 'sqlite' : identity.role) || metadata.rateCoordinator !== (identity.role === 'sqlite-coordinated' ? 'postgres' : undefined)
                || metadata.sha256 !== identity.sha256 || metadata.bytes !== identity.bytes
                || program.length !== identity.bytes || digest(program) !== identity.sha256
                || identity.role === 'management' && metadata.coreVersion !== outer.version)
                return fail();
            if (get(stem + '-NOTICES.txt').length > 2_000_000)
                return fail('limit');
        }
        return { schemaVersion: outer.schemaVersion, ...(outer.schemaVersion === 2 ? { rateCoordinator: outer.rateCoordinator } : {}), status: 'consistent', format: outer.format, version: outer.version,
            artifact: { bytes: bytes.length, sha256: archiveSha256 }, expectedChecksum: expectedSha256 === undefined ? 'not-provided' : 'matched',
            root: outer.root, entrypoint: outer.entrypoint, files: entries.size, runtimes: outer.runtimes,
            authenticity: 'not-verified', privateDataAttestation: 'not-performed; file-contents-not-classified',
            extraction: 'not-performed', installation: 'not-performed', execution: 'not-started-by-inspection', network: 'none', state: 'not-opened' };
    }
    catch (error) {
        if (error instanceof WorkflowRuntimeError)
            return fail(error.code === 'limit' ? 'limit' : 'corrupt');
        return fail(error instanceof BoundedZipError && error.code === 'package-limit' ? 'limit' : 'corrupt');
    }
}
