import { isDeepStrictEqual as same } from 'node:util';
import { ProviderError } from "./config.js";
/** Derivable storage generation; version 1 retains its original one-intent/one-settlement shape. */
export function modelEvidenceVersion(record) {
    if (record.schemaVersion === 1)
        return record.result.status === 'pending' ? 1 : 2;
    const last = record.tries.at(-1).result;
    return record.tries.length * 2 - Number(last.status === 'pending')
        + Number(last.status === 'failed' && last.retryDelayMs !== undefined && record.result.status === 'failed');
}
/** Storage must call this inside its write guard after schema admission; terminal or historical bytes cannot be rewritten. */
export function validateModelEvidenceTransition(previous, next) {
    const conflict = () => { throw new ProviderError('conflict'); };
    if (!previous) {
        if (next.result.status !== 'pending' || modelEvidenceVersion(next) !== 1)
            conflict();
        return;
    }
    if (previous.schemaVersion !== next.schemaVersion || previous.result.status !== 'pending')
        conflict();
    if (previous.schemaVersion === 1 && next.schemaVersion === 1) {
        if (next.result.status === 'pending' || !same({ ...previous, result: null }, { ...next, result: null }))
            conflict();
        return;
    }
    if (previous.schemaVersion !== 2 || next.schemaVersion !== 2)
        return conflict();
    if (!same({ ...previous, result: null, tries: null }, { ...next, result: null, tries: null })
        || modelEvidenceVersion(next) !== modelEvidenceVersion(previous) + 1)
        conflict();
    const before = previous.tries.at(-1), after = next.tries.at(-1);
    if (next.tries.length === previous.tries.length + 1) {
        if (!same(previous.tries, next.tries.slice(0, -1)) || before.result.status !== 'failed' || before.result.retryDelayMs === undefined
            || after.result.status !== 'pending' || next.result.status !== 'pending')
            conflict();
    }
    else if (next.tries.length === previous.tries.length) {
        if (!same(previous.tries.slice(0, -1), next.tries.slice(0, -1)) || !same({ ...before, result: null }, { ...after, result: null }))
            conflict();
        if (before.result.status === 'pending') {
            if (after.result.status === 'pending')
                conflict();
        }
        else if (before.result.status !== 'failed' || before.result.retryDelayMs === undefined || !same(before, after)
            || next.result.status !== 'failed' || !['cancelled', 'timeout'].includes(next.result.code))
            conflict();
    }
    else
        conflict();
}
