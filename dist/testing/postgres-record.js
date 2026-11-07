import { z } from 'zod';
import { JournalError } from "../storage/postgres.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
const savedCase = z.strictObject({ format: z.literal('jevable.pg-test/v1'), record: z.unknown() });
/** Shared replay checks for direct reads and coherent project/test export. */
export async function decodePostgresTest(row, ledger, project, maxRecordBytes) {
    try {
        if (Buffer.byteLength(JSON.stringify(row.value)) > maxRecordBytes)
            throw new WorkflowRuntimeError('corrupt');
        const envelope = savedCase.parse(row.value), record = ledger.decode(envelope.record, row.key, Number(row.version));
        if (row.version !== String(record.versions.length))
            throw new WorkflowRuntimeError('corrupt');
        if (record.importedFrom) {
            const pin = record.versions[0].definition.project;
            ledger.validateImport(record, await project(pin.id, pin.generation));
        }
        for (const version of record.versions) {
            const pin = version.definition.project;
            ledger.validate(version.definition, await project(pin.id, pin.generation), false);
        }
        return record;
    }
    catch (error) {
        if (error instanceof JournalError)
            throw error;
        throw new WorkflowRuntimeError('corrupt');
    }
}
/** Shared encoding for ordinary case writes and atomic project/test imports. Does not commit. */
export function postgresTestWrite(record, expectedVersion, maxRecordBytes) {
    const test = record.versions.at(-1), value = { format: 'jevable.pg-test/v1', record };
    if (Buffer.byteLength(JSON.stringify(value)) > maxRecordBytes)
        throw new WorkflowRuntimeError('limit');
    const change = { operation: 'put', collection: 'test-cases', key: record.id,
        expectedVersion, value: z.json().parse(value) };
    const event = { collection: 'test-cases', key: record.id, kind: `test-${test.operation}`,
        data: { testId: record.id, generation: test.generation, sha256: test.sha256, status: test.status,
            ...(test.archived === undefined ? {} : { archived: test.archived }),
            projectId: test.definition.project.id, projectGeneration: test.definition.project.generation,
            revision: test.definition.project.revision, actor: test.actor, at: test.at } };
    return { change, event };
}
