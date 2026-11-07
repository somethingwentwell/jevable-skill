import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { testDefinitionSchema, testIdentitySchema } from "./schema.js";
import { TEST_ERASURE_POLICY_VERSION } from "./erasure.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const actor = z.string().trim().min(1).max(256);
export const testErasureRequestSchema = z.strictObject({
    requestId: z.uuid().transform(value => value.toLowerCase()), test: testIdentitySchema,
    reviewedHistorySha256: hash, actor,
});
/** CLI request-file and owner HTTP input: attribution is assigned by the selected host. */
export const testErasureCommandSchema = testErasureRequestSchema.omit({ actor: true });
export const testErasureReceiptSchema = z.strictObject({
    schemaVersion: z.literal(1), policy: z.literal(TEST_ERASURE_POLICY_VERSION),
    requestId: z.uuid().regex(/^[a-f0-9-]+$/u), test: testIdentitySchema, historySha256: hash,
    project: testDefinitionSchema.shape.project, actor, at: z.iso.datetime(),
    status: z.literal('logically-removed'), securePhysicalErasure: z.literal(false),
});
export const savedTestErasureSchema = z.strictObject({
    format: z.literal('jevable.test-erasure/v1'), receipt: testErasureReceiptSchema, sha256: hash,
});
export const testErasureReceiptHash = (receipt) => createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
/** Internal preparation only after an owner atomically validates full history and live reference facts. */
export function prepareTestErasureReceipt(command, record) {
    const last = record.versions.at(-1);
    return testErasureReceiptSchema.parse({ schemaVersion: 1, policy: TEST_ERASURE_POLICY_VERSION, requestId: command.requestId,
        test: { ...command.test }, historySha256: command.reviewedHistorySha256, project: { ...last.definition.project },
        actor: command.actor, at: new Date(Math.max(Date.now(), Date.parse(last.at))).toISOString(),
        status: 'logically-removed', securePhysicalErasure: false });
}
/** Exact retries observe a retained receipt; never refresh guards, mint identity or remove anything again. */
export function verifyTestErasureRetry(receipt, command) {
    if (!isDeepStrictEqual({ requestId: receipt.requestId, test: receipt.test, reviewedHistorySha256: receipt.historySha256, actor: receipt.actor }, command))
        throw new WorkflowRuntimeError('conflict');
}
