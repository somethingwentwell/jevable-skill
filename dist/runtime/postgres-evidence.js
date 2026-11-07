import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createRunEvidence, RUN_EVIDENCE_LIMITS } from "./evidence.js";
import { WorkflowRuntimeError } from "./errors.js";
const sequence = z.string().refine(value => /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 9223372036854775806n);
/** A checked, coherent PostgreSQL observation. v2 preserves BIGINT IDs instead of changing v1's numeric contract. */
export function createPostgresRunEvidence(run, events, recordVersion, includePrivate, modelCalls, usageIdentities = false) {
    if (typeof includePrivate !== 'boolean' || typeof usageIdentities !== 'boolean')
        throw new WorkflowRuntimeError('invalid-command');
    if (events.length > RUN_EVIDENCE_LIMITS.events)
        throw new WorkflowRuntimeError('limit');
    if (!events.length || recordVersion !== String(events.length) || events.at(-1)?.at !== run.updatedAt
        || events.some((event, index) => !sequence.safeParse(event.sequence).success || event.version !== String(index + 1)
            || index > 0 && BigInt(event.sequence) <= BigInt(events[index - 1].sequence)))
        throw new WorkflowRuntimeError('corrupt');
    // Reuse the exact allowlisted metadata projection. Ordinals are internal only: every exported
    // header and boundary below carries the original decimal database sequence and record version.
    const { private: _private, ...base } = createRunEvidence(run, events.map((event, index) => ({ ...event, sequence: index + 1 })), false, modelCalls, usageIdentities).snapshot;
    const snapshot = { ...base, schemaVersion: 2,
        storage: { kind: 'postgres', recordVersion },
        journal: base.journal.map((event, index) => ({ ...event, sequence: events[index].sequence, version: events[index].version })),
        boundary: { ...base.boundary, sequenceEncoding: 'decimal-int64',
            firstSequence: events[0].sequence, lastSequence: events.at(-1).sequence },
        privacy: { ...base.privacy, payloads: includePrivate ? 'included' : 'excluded', actors: includePrivate ? 'included' : 'excluded' },
        ...(includePrivate ? { private: { run, journal: events } } : {}) };
    const encoded = JSON.stringify(snapshot);
    if (Buffer.byteLength(encoded) > RUN_EVIDENCE_LIMITS.artifactBytes - 1024)
        throw new WorkflowRuntimeError('limit');
    return { schemaVersion: 2, snapshot, checksum: { algorithm: 'sha256', encoding: 'JSON.stringify(snapshot)',
            value: createHash('sha256').update(encoded).digest('hex') } };
}
