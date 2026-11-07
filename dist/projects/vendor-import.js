/** Owned converter provenance. Uploads stay private; no service, fetch or workflow execution. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CORE_VERSION } from "../capabilities.js";
import { parseWorkflow } from "../workflow/index.js";
import { admitImportedWorkflow } from "../workflow/import/import.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().refine(value => value.isWellFormed() && !value.includes('\0'));
const name = text.trim().min(1).max(256);
const mapping = z.strictObject({ source: text.max(4096), sourceType: text.max(4096), target: text.max(4096).optional(),
    kind: z.enum(['exact', 'approximate', 'unsupported']),
    reason: z.enum(['mapped', 'trigger-mode', 'model-route', 'expression', 'operator', 'code', 'node-type', 'unreachable', 'language', 'loop']) });
const previewFields = {
    schemaVersion: z.literal(1), converter: z.strictObject({ name: z.literal('jevable-owned'), version: name }),
    format: z.enum(['n8n', 'dify', 'coze', 'zapier', 'make', 'power-automate']), version: name, title: name,
    sourceSha256: hash, conversionRevision: hash, yaml: text, mappings: z.array(mapping).max(1000),
};
export const vendorImportPreviewSchema = z.strictObject({ ...previewFields, conversionSha256: hash });
export const vendorImportCommandSchema = z.strictObject({ id: z.uuid().transform(value => value.toLowerCase()), title: name, actor: name,
    source: text, yaml: text, reviewedSourceSha256: hash, reviewedConversionSha256: hash, reviewedRevision: hash });
export const vendorImportRecordSchema = z.strictObject({ schemaVersion: z.literal(1), projectId: z.uuid(), title: name, actor: name,
    at: z.iso.datetime(), source: text, conversion: vendorImportPreviewSchema, revision: hash, requestSha256: hash });
const digest = (value) => createHash('sha256').update(value).digest('hex');
function fail(code) { throw new WorkflowRuntimeError(code); }
const bound = (value, maximum) => { if (Buffer.byteLength(value) > maximum)
    fail('limit'); };
/** Operation-local admission witness. Never exposed in reports or retained across requests. */
function admittedVendorImport(source, limits) {
    if (!text.safeParse(source).success)
        fail('invalid-command');
    bound(source, limits.maxSourceBytes);
    const { converted, admitted } = admitImportedWorkflow(source, limits, parseWorkflow);
    const parsed = z.strictObject(previewFields).safeParse({ schemaVersion: 1, converter: { name: 'jevable-owned', version: CORE_VERSION },
        ...converted, yaml: admitted.yaml, conversionRevision: admitted.revision });
    if (!parsed.success)
        fail('limit');
    const result = { ...parsed.data, conversionSha256: digest(JSON.stringify(parsed.data)) };
    // A bounded upload need not yield a bounded report; account for the complete retained preview.
    bound(JSON.stringify(result), 4 * limits.maxSourceBytes);
    return { preview: result, admitted };
}
export function previewVendorImport(source, limits) {
    return admittedVendorImport(source, limits).preview;
}
export function prepareVendorImport(value, limits) {
    const parsed = vendorImportCommandSchema.safeParse(value);
    if (!parsed.success)
        fail('invalid-command');
    const command = parsed.data;
    bound(command.source, limits.maxSourceBytes);
    bound(command.yaml, limits.maxSourceBytes);
    const { preview: conversion, admitted } = admittedVendorImport(command.source, limits);
    // Only byte-identical canonical text can reuse this operation's immutable admission.
    // Edited/reformatted drafts still pass ordinary parsing under the same owner budgets.
    const draft = command.yaml === admitted.yaml ? admitted : parseWorkflow(command.yaml, limits);
    if (conversion.sourceSha256 !== command.reviewedSourceSha256 || conversion.conversionSha256 !== command.reviewedConversionSha256
        || draft.revision !== command.reviewedRevision
        || draft.document.metadata.id !== admitted.document.metadata.id)
        fail('conflict');
    const canonical = { ...command, yaml: draft.yaml };
    return { command: canonical, conversion, requestSha256: digest(JSON.stringify(canonical)) };
}
/** Validate retained identity without re-running a potentially newer converter or trusting uploaded report fields.
 * readSource is an internal, operation-local parser adapter, never a file/wire witness.
 * The ledger may reuse immutable text it just admitted under these same limits;
 * ordinary callers still parse every source through the default admission path.
 */
export function verifyVendorImport(record, projectId, first, yaml, limits, readSource = parseWorkflow) {
    try {
        const value = vendorImportRecordSchema.parse(record);
        bound(value.source, limits.maxSourceBytes);
        bound(value.conversion.yaml, limits.maxSourceBytes);
        const draft = readSource(yaml, limits);
        const converted = value.conversion.yaml === yaml ? draft : readSource(value.conversion.yaml, limits);
        const { conversionSha256, ...preview } = value.conversion;
        if (value.projectId !== projectId || first.operation !== 'create' || first.copiedFrom !== undefined
            || first.title !== value.title || first.actor !== value.actor || first.at !== value.at
            || first.revision !== value.revision || draft.revision !== value.revision
            || converted.revision !== preview.conversionRevision || converted.yaml !== preview.yaml
            || converted.document.metadata.id !== draft.document.metadata.id || digest(value.source) !== preview.sourceSha256
            || digest(JSON.stringify(preview)) !== conversionSha256)
            fail('corrupt');
        const command = vendorImportCommandSchema.parse({ id: projectId, title: value.title, actor: value.actor,
            source: value.source, yaml: draft.yaml, reviewedSourceSha256: preview.sourceSha256,
            reviewedConversionSha256: conversionSha256, reviewedRevision: value.revision });
        if (digest(JSON.stringify(command)) !== value.requestSha256)
            fail('corrupt');
    }
    catch {
        fail('corrupt');
    }
}
const viewFields = { schemaVersion: z.literal(1), projectId: z.uuid(), revision: hash, at: z.iso.datetime(),
    converter: previewFields.converter, format: previewFields.format, version: name, sourceSha256: hash, conversionSha256: hash,
    conversionRevision: hash, requestSha256: hash, sha256: hash,
    mappingCounts: z.strictObject({ exact: z.number().int().nonnegative(), approximate: z.number().int().nonnegative(), unsupported: z.number().int().nonnegative() }),
    transfer: z.literal('excluded-from-project-bundles'), execution: z.literal('not-run') };
export const vendorImportViewSchema = z.discriminatedUnion('privatePayloads', [
    z.strictObject({ ...viewFields, privatePayloads: z.literal('excluded') }),
    z.strictObject({ ...viewFields, privatePayloads: z.literal('included'), record: vendorImportRecordSchema }),
]);
export function vendorImportView(record, inspect) {
    if (typeof inspect !== 'boolean')
        fail('invalid-command');
    const counts = { exact: 0, approximate: 0, unsupported: 0 };
    for (const item of record.conversion.mappings)
        counts[item.kind]++;
    return vendorImportViewSchema.parse({ schemaVersion: 1, projectId: record.projectId, revision: record.revision, at: record.at,
        converter: { ...record.conversion.converter }, format: record.conversion.format, version: record.conversion.version,
        sourceSha256: record.conversion.sourceSha256, conversionSha256: record.conversion.conversionSha256,
        conversionRevision: record.conversion.conversionRevision, requestSha256: record.requestSha256,
        sha256: digest(JSON.stringify(record)), mappingCounts: counts, privatePayloads: inspect ? 'included' : 'excluded',
        ...(inspect ? { record: structuredClone(record) } : {}), transfer: 'excluded-from-project-bundles', execution: 'not-run' });
}
