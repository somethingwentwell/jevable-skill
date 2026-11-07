/// <reference lib="dom" />
/** Import-free, serializable admission of a runtime-produced JSON snapshot, shared by CLI and preview; not independent authenticity or secret scrubbing. */
export async function prepareEvidenceDownload(expected, value, includePrivate = false) {
    expected = { runId: expected.runId, revision: expected.revision };
    const fail = () => { throw Error('Evidence does not match the selected run, privacy choice or checksum.'); };
    const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value : fail();
    const exact = (value, names) => {
        if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name)))
            fail();
    };
    if (typeof includePrivate !== 'boolean' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(expected.runId)
        || !/^[a-f0-9]{64}$/.test(expected.revision))
        fail();
    // Detach before asynchronous hashing: caller mutation must not change the artifact after verification.
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).byteLength + 1 > 16_000_000)
        fail();
    const envelope = object(JSON.parse(encoded)), snapshot = object(envelope.snapshot), run = object(snapshot.run);
    const checksum = object(envelope.checksum), privacy = object(snapshot.privacy);
    exact(envelope, ['schemaVersion', 'snapshot', 'checksum']);
    exact(checksum, ['algorithm', 'encoding', 'value']);
    if (![1, 2].includes(envelope.schemaVersion) || snapshot.schemaVersion !== envelope.schemaVersion
        || snapshot.format !== 'jevable.ai/run-evidence' || run.id !== expected.runId || run.revision !== expected.revision
        || !['paused', 'waiting', 'executing', 'completed', 'failed', 'cancelled'].includes(run.status)
        || privacy.payloads !== (includePrivate ? 'included' : 'excluded') || privacy.actors !== (includePrivate ? 'included' : 'excluded')
        || privacy.credentialStore !== 'excluded' || Object.hasOwn(snapshot, 'private') !== includePrivate
        || checksum.algorithm !== 'sha256' || checksum.encoding !== 'JSON.stringify(snapshot)'
        || typeof checksum.value !== 'string' || !/^[a-f0-9]{64}$/.test(checksum.value))
        fail();
    if (includePrivate) {
        const privateRun = object(object(snapshot.private).run);
        if (privateRun.id !== expected.runId || privateRun.revision !== expected.revision)
            fail();
    }
    // Optional for legacy evidence. New ordinals must agree with the retained intent order,
    // not provider retry counts, step indexes or decimal PostgreSQL database sequences.
    if (Object.hasOwn(snapshot, 'nodeAttempts')) {
        const attempts = object(snapshot.nodeAttempts);
        exact(attempts, ['format', 'source', 'numbering', 'entries']);
        if (attempts.format !== 'jevable.node-attempts/v1' || attempts.source !== 'retained-intents'
            || attempts.numbering !== 'per-node-and-loop-scope' || !Array.isArray(attempts.entries)
            || !Array.isArray(snapshot.journal) || snapshot.journal.length > 50000)
            fail();
        const counts = new Map(), ids = new Set(), entries = [];
        for (const value of snapshot.journal) {
            const event = object(value);
            if (event.kind !== 'node-intent')
                continue;
            const attemptId = event.attemptId, nodeId = event.nodeId;
            if (typeof attemptId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(attemptId)
                || typeof nodeId !== 'string' || !nodeId.length || ids.has(attemptId.toLowerCase()))
                fail();
            ids.add(attemptId.toLowerCase());
            const scope = event.scope == null ? undefined : object(event.scope);
            if (scope) {
                exact(scope, ['loop', 'index']);
                if (typeof scope.loop !== 'string' || !scope.loop.length || !Number.isSafeInteger(scope.index) || scope.index < 0)
                    fail();
            }
            const key = JSON.stringify([nodeId, scope?.loop ?? null, scope?.index ?? null]);
            const number = (counts.get(key) ?? 0) + 1;
            counts.set(key, number);
            entries.push({ attemptId, nodeId, ...(scope ? { scope } : {}), number });
        }
        const declaredEntries = attempts.entries;
        if (declaredEntries.length !== entries.length)
            fail();
        for (const [index, value] of declaredEntries.entries()) {
            const actual = object(value), wanted = entries[index];
            exact(actual, wanted.scope ? ['attemptId', 'nodeId', 'scope', 'number'] : ['attemptId', 'nodeId', 'number']);
            if (actual.attemptId !== wanted.attemptId || actual.nodeId !== wanted.nodeId || actual.number !== wanted.number)
                fail();
            if (wanted.scope) {
                const scope = object(actual.scope);
                exact(scope, ['loop', 'index']);
                if (scope.loop !== wanted.scope.loop || scope.index !== wanted.scope.index)
                    fail();
            }
        }
    }
    const snapshotSha256 = checksum.value;
    const digest = async (text) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('');
    if (await digest(JSON.stringify(snapshot)) !== snapshotSha256)
        fail();
    const contents = encoded + '\n', sha256 = await digest(contents);
    return { filename: `jevable-run-${expected.runId}-${includePrivate ? 'private' : 'metadata'}-${sha256.slice(0, 12)}.json`,
        contents, bytes: new TextEncoder().encode(contents).byteLength, sha256, snapshotSha256,
        runId: expected.runId, revision: expected.revision, workflowStatus: run.status, includePrivate };
}
