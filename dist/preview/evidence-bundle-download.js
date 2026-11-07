/// <reference lib="dom" />
/** Browser-safe receipt/byte verification; the server builds/validates ZIP entries. This does not authenticate a publisher. */
export async function prepareEvidenceBundleDownload(expected, value, includePrivate = false) {
    const fail = () => { throw Error('Evidence bundle verification failed'); };
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, hash = /^[a-f0-9]{64}$/;
    const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    if (typeof includePrivate !== 'boolean' || !exact(expected, ['schemaVersion', 'runs']) || expected.schemaVersion !== 1
        || !Array.isArray(expected.runs) || !expected.runs.length || expected.runs.length > 100
        || expected.runs.some(run => !exact(run, ['id', 'revision']) || !uuid.test(run.id) || !hash.test(run.revision))
        || new Set(expected.runs.map(run => run.id.toLowerCase())).size !== expected.runs.length)
        return fail();
    const selection = { schemaVersion: 1, runs: expected.runs.map(run => ({ id: run.id, revision: run.revision })) };
    const raw = value;
    if (!exact(raw, ['schemaVersion', 'format', 'selection', 'selectionSha256', 'privacy', 'bytes', 'sha256', 'base64', 'runs', 'execution', 'restoration'])
        || typeof raw.base64 !== 'string' || raw.base64.length > 16_000_000)
        return fail();
    // Detach before awaiting digest; later SDK/controller mutations cannot retarget the verified artifact.
    const json = JSON.stringify(raw);
    if (json.length > 20_000_000)
        return fail();
    const data = JSON.parse(json);
    if (data.schemaVersion !== 1 || data.format !== 'jevable.ai/preview-evidence-zip'
        || JSON.stringify(data.selection) !== JSON.stringify(selection) || !hash.test(data.selectionSha256) || !hash.test(data.sha256)
        || data.privacy !== (includePrivate ? 'private-execution-data' : 'metadata-only')
        || !Number.isSafeInteger(data.bytes) || data.bytes < 4 || data.bytes > 12_000_000
        || data.base64.length !== 4 * Math.ceil(data.bytes / 3)
        || data.execution !== 'not-started-or-resumed-by-export' || data.restoration !== 'unsupported'
        || !Array.isArray(data.runs) || data.runs.length !== selection.runs.length
        || data.runs.some((run, index) => !run || run.id !== selection.runs[index].id || run.revision !== selection.runs[index].revision
            || !['completed', 'failed', 'cancelled', 'executing', 'waiting', 'paused'].includes(run.workflowStatus)
            || !hash.test(run.snapshotSha256) || run.evidencePath !== `runs/${run.id}.json`
            || typeof run.observedRunUpdatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(run.observedRunUpdatedAt)
            || (run.testPath === undefined
                ? !exact(run, ['id', 'revision', 'workflowStatus', 'observedRunUpdatedAt', 'evidencePath', 'snapshotSha256'])
                : !exact(run, ['id', 'revision', 'workflowStatus', 'observedRunUpdatedAt', 'evidencePath', 'snapshotSha256', 'testPath', 'test', 'assessment'])
                    || run.testPath !== `tests/${run.id}.json` || !exact(run.test, ['id', 'generation', 'sha256'])
                    || !uuid.test(run.test.id) || !Number.isSafeInteger(run.test.generation) || run.test.generation < 1
                    || !hash.test(run.test.sha256) || !['passed', 'failed', 'pending', 'uncertain'].includes(run.assessment))))
        return fail();
    const binary = atob(data.base64);
    if (binary.length !== data.bytes || btoa(binary) !== data.base64)
        return fail();
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < bytes.length; index++)
        bytes[index] = binary.charCodeAt(index);
    if (bytes[0] !== 80 || bytes[1] !== 75 || bytes[2] !== 3 || bytes[3] !== 4)
        return fail();
    const sha = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
        .map(value => value.toString(16).padStart(2, '0')).join('');
    if (await sha(new TextEncoder().encode(JSON.stringify(selection))) !== data.selectionSha256 || await sha(bytes) !== data.sha256)
        return fail();
    const summary = data.runs.map(run => ({ id: run.id, workflowStatus: run.workflowStatus,
        assessment: run.assessment }));
    return { bytes, sha256: data.sha256, selectionSha256: data.selectionSha256, runs: selection.runs.length,
        summary,
        privacy: data.privacy,
        filename: `jevable-evidence-${data.selectionSha256.slice(0, 16)}-${includePrivate ? 'private' : 'metadata'}.zip` };
}
