/** Serialized browser helpers. Receipt/hash checks are not publisher authentication or ZIP-entry inspection. */
export function previewReleaseTools() {
    const fail = () => { throw Error('Release verification failed'); };
    const hash = /^[a-f0-9]{64}$/, uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    const exact = (x, keys) => x && typeof x === 'object' && !Array.isArray(x)
        && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
    // This function is serialized into the browser: no Node/Zod/checkout dependency.
    const noteText = (value) => {
        if (typeof value !== 'string' || !value.length || value.length > 16_384 || !value.isWellFormed()
            || !value.trim().length || new TextEncoder().encode(value).byteLength > 16_384
            || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))
            return fail();
        return value;
    };
    const checkedReceipt = (value, pin, id, list) => {
        const r = value;
        const keys = ['schemaVersion', 'format', 'id', 'releaseSha256', 'project', 'version', 'runtime', 'storage', 'execution'];
        if (r && Object.hasOwn(r, 'notes')) {
            if (list)
                return fail();
            noteText(r.notes);
            keys.push('notes');
        }
        if (!exact(r, keys)
            || r.schemaVersion !== 1 || r.format !== 'jevable.ai/preview-release' || !uuid.test(r.id) || r.id !== id || !hash.test(r.releaseSha256)
            || !exact(r.project, ['id', 'generation', 'revision']) || r.project.id !== pin.id || !uuid.test(r.project.id)
            || r.project.generation !== pin.generation || !Number.isSafeInteger(r.project.generation) || r.project.generation < 1
            || r.project.revision !== pin.revision || !hash.test(r.project.revision)
            || typeof r.version !== 'string' || r.version.length > 128 || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(r.version)
            || !exact(r.runtime, ['version', 'sha256']) || typeof r.runtime.version !== 'string' || !r.runtime.version.length || r.runtime.version.length > 128
            || !hash.test(r.runtime.sha256) || !(list && r.storage === null || ['sqlite', 'postgres'].includes(r.storage)) || r.execution !== 'not-run')
            return fail();
        return JSON.parse(JSON.stringify(r));
    };
    const receipt = (value, pin, id) => checkedReceipt(value, pin, id, false);
    const download = async (expected, value, evidence = null) => {
        const saved = receipt(expected, expected.project, expected.id), raw = value;
        const wanted = evidence === null ? null : { ...evidence };
        if (wanted && (!exact(wanted, ['sha256', 'selectionSha256', 'privacy']) || !hash.test(wanted.sha256)
            || !hash.test(wanted.selectionSha256) || !['metadata-only', 'private-execution-data'].includes(wanted.privacy)))
            return fail();
        if (!exact(raw, ['schemaVersion', 'format', 'release', 'bytes', 'sha256', 'base64', 'evidence', 'execution', 'restoration'])
            || typeof raw.base64 !== 'string' || raw.base64.length > 16_000_000)
            return fail();
        const json = JSON.stringify(raw);
        if (json.length > 20_000_000)
            return fail();
        const data = JSON.parse(json), actual = receipt(data.release, saved.project, saved.id);
        if (data.schemaVersion !== 1 || data.format !== 'jevable.ai/preview-release-zip' || JSON.stringify(actual) !== JSON.stringify(saved)
            || !hash.test(data.sha256) || !Number.isSafeInteger(data.bytes) || data.bytes < 4 || data.bytes > 12_000_000
            || data.base64.length !== 4 * Math.ceil(data.bytes / 3) || data.execution !== 'not-run' || data.restoration !== 'unsupported'
            || (wanted === null ? data.evidence !== null : !exact(data.evidence, ['sha256', 'selectionSha256', 'privacy'])
                || data.evidence.sha256 !== wanted.sha256 || data.evidence.selectionSha256 !== wanted.selectionSha256 || data.evidence.privacy !== wanted.privacy))
            return fail();
        const binary = atob(data.base64);
        if (binary.length !== data.bytes || btoa(binary) !== data.base64)
            return fail();
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < bytes.length; i++)
            bytes[i] = binary.charCodeAt(i);
        if (bytes[0] !== 80 || bytes[1] !== 75 || bytes[2] !== 3 || bytes[3] !== 4)
            return fail();
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(x => x.toString(16).padStart(2, '0')).join('');
        if (digest !== data.sha256)
            return fail();
        return { bytes, sha256: digest, filename: `jevable-release-${saved.id}-${wanted ? wanted.privacy : 'no-evidence'}.zip` };
    };
    const page = (value, pin) => {
        const raw = value;
        if (!exact(raw, ['schemaVersion', 'format', 'project', 'releases', 'nextCursor', 'execution'])
            || raw.schemaVersion !== 1 || raw.format !== 'jevable.ai/preview-release-page' || raw.execution !== 'not-run'
            || !uuid.test(pin.id) || !Number.isSafeInteger(pin.generation) || pin.generation < 1 || !hash.test(pin.revision)
            || !exact(raw.project, ['id', 'generation', 'revision']) || raw.project.id !== pin.id
            || raw.project.generation !== pin.generation || raw.project.revision !== pin.revision
            || !Array.isArray(raw.releases) || raw.releases.length > 25
            || raw.nextCursor !== null && (typeof raw.nextCursor !== 'string' || !hash.test(raw.nextCursor))
            || JSON.stringify(raw).length > 100000)
            return fail();
        const releases = raw.releases.map((r) => {
            if (!r || Object.hasOwn(r, 'notes'))
                return fail();
            return checkedReceipt(r, pin, r.id, true);
        });
        if (new Set(releases.map((r) => r.id)).size !== releases.length
            || releases.some((r, i) => i > 0 && r.id <= releases[i - 1].id))
            return fail();
        return { schemaVersion: 1, format: 'jevable.ai/preview-release-page', project: { ...pin }, releases,
            nextCursor: raw.nextCursor, execution: 'not-run' };
    };
    return { receipt, download, noteText, page };
}
