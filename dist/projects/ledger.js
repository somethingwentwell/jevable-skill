import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { parseWorkflow, diffWorkflows } from "../workflow/index.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { transferredTestsSchema, testHash } from "../testing/schema.js";
import { prepareVendorImport, verifyVendorImport, vendorImportView, vendorImportRecordSchema } from "./vendor-import.js";
const revision = z.string().regex(/^[a-f0-9]{64}$/u);
const title = z.string().trim().min(1).max(256);
const actor = z.string().trim().min(1).max(256);
const acknowledgements = z.array(z.string().min(1).max(512)).max(500);
const header = { actor, at: z.iso.datetime() };
const copiedFromSchema = z.strictObject({ id: z.uuid(), generation: z.number().int().positive(), revision });
export const deleteCommandSchema = z.strictObject({ id: z.uuid(), expectedGeneration: z.number().int().positive(), actor });
export const deletionSchema = z.strictObject({ schemaVersion: z.literal(1), id: z.uuid(), generation: z.number().int().positive(),
    revision, actor, at: z.iso.datetime(), status: z.literal('deleted') });
const changeSchema = z.discriminatedUnion('operation', [
    z.strictObject({ ...header, operation: z.literal('create'), title, revision, copiedFrom: copiedFromSchema.optional() }),
    z.strictObject({ ...header, operation: z.literal('propose'), proposalId: z.uuid(), base: revision, revision }),
    z.strictObject({ ...header, operation: z.literal('accept'), proposalId: z.uuid(), revision, approvalChanges: acknowledgements }),
    z.strictObject({ ...header, operation: z.literal('reject'), proposalId: z.uuid(), revision }),
    z.strictObject({ ...header, operation: z.literal('restore'), revision, approvalChanges: acknowledgements }),
    z.strictObject({ ...header, operation: z.literal('rename'), title }),
    z.strictObject({ ...header, operation: z.literal('archive'), archived: z.boolean() }),
    z.strictObject({ ...header, operation: z.literal('import'), bundleSha256: revision, sourceProjectId: z.uuid(),
        sourceGeneration: z.number().int().positive(), historyIncluded: z.boolean() }),
]);
const recordSchema = z.strictObject({ schemaVersion: z.literal(1), id: z.uuid(),
    revisions: z.array(z.strictObject({ revision, yaml: z.string() })).min(1).max(100),
    changes: z.array(changeSchema).min(1).max(1000), vendorImport: vendorImportRecordSchema.optional() });
const bundleFields = { format: z.literal('jevable.ai/project-bundle'),
    exportedAt: z.iso.datetime(), source: z.strictObject({ id: z.uuid(), generation: z.number().int().positive() }), title,
    accepted: z.strictObject({ revision, yaml: z.string() }), history: recordSchema.optional() };
const bundleSchema = z.discriminatedUnion('version', [z.strictObject({ ...bundleFields, version: z.literal(1) }),
    z.strictObject({ ...bundleFields, version: z.literal(2), tests: transferredTestsSchema })]);
export { bundleSchema as projectBundleSchema };
const guard = { id: z.uuid(), expectedGeneration: z.number().int().positive(), actor };
export const projectCommandSchema = z.discriminatedUnion('operation', [
    z.strictObject({ operation: z.literal('create'), id: z.uuid().optional(), title, yaml: z.string(), actor }),
    z.strictObject({ ...guard, operation: z.literal('duplicate'), revision, title, newId: z.uuid().optional() }),
    z.strictObject({ ...guard, operation: z.literal('propose'), yaml: z.string(), proposalId: z.uuid().optional() }),
    z.strictObject({ ...guard, operation: z.literal('accept'), proposalId: z.uuid(), reviewedRevision: revision, approvalChanges: acknowledgements }),
    z.strictObject({ ...guard, operation: z.literal('reject'), proposalId: z.uuid(), reviewedRevision: revision }),
    z.strictObject({ ...guard, operation: z.literal('restore'), revision, approvalChanges: acknowledgements }),
    z.strictObject({ ...guard, operation: z.literal('rename'), title }),
    z.strictObject({ ...guard, operation: z.literal('archive'), archived: z.boolean() }),
]);
/** Conservative review: any execution-spec change may bypass an unchanged approval node.
 * Presentation-only changes need no acknowledgement. This is not a reachability proof. */
export function approvalChanges(before, after) {
    const { presentation: _before, ...oldSpec } = before.document.spec;
    const { presentation: _after, ...newSpec } = after.document.spec;
    if (isDeepStrictEqual(oldSpec, newSpec) && isDeepStrictEqual(before.document.extensions, after.document.extensions))
        return [];
    const names = [];
    for (const [id, node] of Object.entries(before.document.spec.nodes)) {
        if (node.type === 'humanApproval')
            names.push(id);
        if (node.type === 'loop') {
            const body = z.object({ nodes: z.record(z.string(), z.unknown()) }).safeParse(node.config.body);
            if (body.success)
                for (const [child, value] of Object.entries(body.data.nodes)) {
                    if (z.object({ type: z.literal('humanApproval') }).safeParse(value).success)
                        names.push(`${id}/${child}`);
                }
        }
    }
    return names.sort();
}
/** Shared revision/review semantics. No database, process, credential or harness dependency. */
export class ProjectLedger {
    limits;
    maxRecordBytes;
    constructor(limits, maxRecordBytes) {
        this.limits = limits;
        this.maxRecordBytes = maxRecordBytes;
    }
    replay(record, through = record.changes.length) {
        const fail = () => { throw new WorkflowRuntimeError('corrupt'); };
        if (!Number.isSafeInteger(through) || through < 1 || through > record.changes.length)
            return fail();
        const sources = new Map();
        for (const item of record.revisions) {
            const source = parseWorkflow(item.yaml, this.limits);
            if (sources.has(item.revision) || source.revision !== item.revision || source.yaml !== item.yaml)
                return fail();
            sources.set(item.revision, source);
        }
        const first = record.changes[0];
        if (first.operation !== 'create' || !sources.has(first.revision))
            return fail();
        if (record.vendorImport) {
            const draft = sources.get(first.revision);
            // Every revision above was admitted in this replay under this owner's current
            // limits. Reuse only this exact canonical text, never a retained/uploaded
            // witness or an admission from another request. Distinct conversion text
            // still passes the ordinary parser and all provenance checks below.
            verifyVendorImport(record.vendorImport, record.id, first, draft.yaml, this.limits, (yaml, limits) => yaml === draft.yaml ? draft : parseWorkflow(yaml, limits));
        }
        if (first.copiedFrom && (first.copiedFrom.id === record.id || first.copiedFrom.revision !== first.revision))
            return fail();
        const workflowId = sources.get(first.revision).document.metadata.id;
        if ([...sources.values()].some(source => source.document.metadata.id !== workflowId))
            return fail();
        let name = first.title, acceptedRevision = first.revision, archived = false;
        const proposals = [], accepted = new Set([first.revision]), used = new Set([first.revision]);
        const changes = record.changes.slice(0, through);
        for (const [index, change] of changes.entries()) {
            if (index === 0)
                continue;
            if (change.at < changes[index - 1].at || change.operation === 'create')
                return fail();
            if (archived && !['rename', 'archive', 'import'].includes(change.operation))
                return fail();
            if ('revision' in change && !sources.has(change.revision))
                return fail();
            if (change.operation === 'propose') {
                if (change.base !== acceptedRevision || proposals.some(p => p.id === change.proposalId))
                    return fail();
                proposals.push({ id: change.proposalId, base: change.base, revision: change.revision, status: 'pending' });
                used.add(change.revision);
            }
            else if (change.operation === 'accept' || change.operation === 'reject') {
                const proposal = proposals.find(p => p.id === change.proposalId);
                if (!proposal || proposal.status !== 'pending' || proposal.revision !== change.revision)
                    return fail();
                if (change.operation === 'accept') {
                    if (proposal.base !== acceptedRevision || !isDeepStrictEqual(change.approvalChanges, approvalChanges(sources.get(acceptedRevision), sources.get(change.revision))))
                        return fail();
                    acceptedRevision = change.revision;
                    accepted.add(acceptedRevision);
                    proposal.status = 'accepted';
                }
                else
                    proposal.status = 'rejected';
            }
            else if (change.operation === 'restore') {
                if (!accepted.has(change.revision) || !isDeepStrictEqual(change.approvalChanges, approvalChanges(sources.get(acceptedRevision), sources.get(change.revision))))
                    return fail();
                acceptedRevision = change.revision;
            }
            else if (change.operation === 'rename')
                name = change.title;
            else if (change.operation === 'archive')
                archived = change.archived;
            else if (change.operation === 'import' && (change.sourceProjectId === record.id
                || (change.historyIncluded ? change.sourceGeneration !== index : index !== 1)))
                return fail();
        }
        if (through === record.changes.length && sources.size !== used.size)
            return fail();
        return { schemaVersion: 1, id: record.id, workflowId, title: name, generation: through, acceptedRevision, archived,
            createdAt: first.at, updatedAt: changes.at(-1).at, proposals, changes,
            revisions: record.revisions.filter(item => used.has(item.revision)) };
    }
    command(value) {
        const parsed = projectCommandSchema.safeParse(value);
        if (!parsed.success)
            throw new WorkflowRuntimeError('invalid-command');
        return parsed.data;
    }
    decode(encoded, id, generation) {
        if (!z.uuid().safeParse(id).success)
            throw new WorkflowRuntimeError('invalid-command');
        if (Buffer.byteLength(encoded) > this.maxRecordBytes)
            throw new WorkflowRuntimeError('limit');
        try {
            const record = recordSchema.parse(JSON.parse(encoded));
            if (record.id !== id || (generation !== undefined && record.changes.length !== generation))
                throw new Error();
            this.replay(record);
            return record;
        }
        catch {
            throw new WorkflowRuntimeError('corrupt');
        }
    }
    export(record, expectedGeneration, reviewedRevision, history = false, tests) {
        if (typeof history !== 'boolean')
            throw new WorkflowRuntimeError('invalid-command');
        const project = this.replay(record), id = record.id;
        if (project.generation !== expectedGeneration || project.acceptedRevision !== reviewedRevision)
            throw new WorkflowRuntimeError('conflict');
        const accepted = project.revisions.find(item => item.revision === reviewedRevision);
        // An original vendor upload is private, separate from authored source/history. Never transfer its authority by default.
        const { vendorImport: _privateImport, ...portableHistory } = record;
        const bundle = { format: 'jevable.ai/project-bundle', ...(tests ? { version: 2, tests } : { version: 1 }), exportedAt: new Date().toISOString(),
            source: { id, generation: project.generation }, title: project.title, accepted,
            ...(history ? { history: portableHistory } : {}) };
        if (Buffer.byteLength(JSON.stringify(bundle)) > this.maxRecordBytes)
            throw new WorkflowRuntimeError('limit');
        return bundle;
    }
    inspectImport(json) {
        if (typeof json !== 'string' || Buffer.byteLength(json) > this.maxRecordBytes)
            throw new WorkflowRuntimeError('limit');
        let bundle;
        try {
            bundle = bundleSchema.parse(JSON.parse(json));
        }
        catch {
            throw new WorkflowRuntimeError('invalid-command');
        }
        const source = parseWorkflow(bundle.accepted.yaml, this.limits);
        if (source.revision !== bundle.accepted.revision || source.yaml !== bundle.accepted.yaml)
            throw new WorkflowRuntimeError('conflict');
        if (bundle.history) {
            if (bundle.history.vendorImport !== undefined)
                throw new WorkflowRuntimeError('invalid-command');
            const project = this.replay(bundle.history);
            if (project.id !== bundle.source.id || project.generation !== bundle.source.generation || project.title !== bundle.title
                || project.acceptedRevision !== bundle.accepted.revision)
                throw new WorkflowRuntimeError('conflict');
        }
        if (bundle.version === 2) {
            if (new Set(bundle.tests.cases.map(item => item.source.id)).size !== bundle.tests.cases.length)
                throw new WorkflowRuntimeError('conflict');
            for (const item of bundle.tests.cases) {
                if (item.definition.project.id !== bundle.source.id || item.definition.project.revision !== bundle.accepted.revision
                    || item.definition.project.generation > bundle.source.generation || testHash(item.definition) !== item.source.sha256)
                    throw new WorkflowRuntimeError('conflict');
                if (bundle.history && this.replay(bundle.history, item.definition.project.generation).acceptedRevision !== item.definition.project.revision)
                    throw new WorkflowRuntimeError('conflict');
            }
        }
        return { bundle, sha256: createHash('sha256').update(json).digest('hex') };
    }
    prepareImport(json, reviewedSha256, importActor, newId, allowTests = false) {
        const input = z.strictObject({ reviewedSha256: revision, actor, id: z.uuid().optional() }).safeParse({ reviewedSha256, actor: importActor,
            ...(newId === undefined ? {} : { id: newId }) });
        if (!input.success)
            throw new WorkflowRuntimeError('invalid-command');
        const { bundle, sha256 } = this.inspectImport(json);
        if (bundle.version === 2 && bundle.tests.cases.length && !allowTests)
            throw new WorkflowRuntimeError('invalid-command');
        if (sha256 !== reviewedSha256)
            throw new WorkflowRuntimeError('conflict');
        const id = input.data.id ?? randomUUID();
        if (id === bundle.source.id)
            throw new WorkflowRuntimeError('conflict');
        const now = new Date().toISOString();
        // Imported actors are external historical claims. The appended event records the actual local importer.
        const record = bundle.history ? structuredClone(bundle.history) : { schemaVersion: 1, id,
            revisions: [bundle.accepted], changes: [{ operation: 'create', actor: input.data.actor, at: now,
                    title: bundle.title, revision: bundle.accepted.revision }] };
        record.id = id;
        const previous = record.changes.at(-1).at;
        record.changes.push({ operation: 'import', actor: input.data.actor, at: previous > now ? previous : now,
            bundleSha256: sha256, sourceProjectId: bundle.source.id, sourceGeneration: bundle.source.generation, historyIncluded: Boolean(bundle.history) });
        if (record.changes.length > 1000)
            throw new WorkflowRuntimeError('limit');
        const encoded = JSON.stringify(recordSchema.parse(record));
        if (Buffer.byteLength(encoded) > this.maxRecordBytes)
            throw new WorkflowRuntimeError('limit');
        const project = this.replay(record);
        return { record, project, bundle };
    }
    diff(record, from, to) {
        const project = this.replay(record);
        const source = (hash) => {
            const item = project.revisions.find(item => item.revision === hash);
            if (!item)
                throw new WorkflowRuntimeError('not-found');
            return parseWorkflow(item.yaml, this.limits);
        };
        const before = source(from), after = source(to);
        return { ...diffWorkflows(before, after), approvalChanges: approvalChanges(before, after) };
    }
    /** Actor must come from the authenticated adapter. It is attribution, not proof of human consent. */
    createVendorImport(value, previous) {
        const prepared = prepareVendorImport(value, this.limits), command = prepared.command;
        if (previous) {
            this.replay(previous);
            if (previous.id !== command.id || previous.vendorImport?.requestSha256 !== prepared.requestSha256)
                throw new WorkflowRuntimeError('conflict');
            return { record: previous, project: this.replay(previous, 1), replayed: true };
        }
        const created = this.apply({ operation: 'create', id: command.id, title: command.title, yaml: command.yaml, actor: command.actor });
        created.record.vendorImport = { schemaVersion: 1, projectId: command.id, title: command.title, actor: command.actor,
            at: created.project.createdAt, source: command.source, conversion: prepared.conversion,
            revision: command.reviewedRevision, requestSha256: prepared.requestSha256 };
        if (Buffer.byteLength(JSON.stringify(created.record)) > this.maxRecordBytes)
            throw new WorkflowRuntimeError('limit');
        return { ...created, project: this.replay(created.record), replayed: false };
    }
    vendorImport(record, inspect = false) {
        if (typeof inspect !== 'boolean')
            throw new WorkflowRuntimeError('invalid-command');
        this.replay(record);
        return record.vendorImport ? vendorImportView(record.vendorImport, inspect) : null;
    }
    apply(value, previous) {
        const parsed = projectCommandSchema.safeParse(value);
        if (!parsed.success)
            throw new WorkflowRuntimeError('invalid-command');
        const command = parsed.data;
        let record, change;
        const now = new Date().toISOString();
        if (command.operation === 'create' || command.operation === 'duplicate') {
            const id = (command.operation === 'duplicate' ? command.newId : command.id) ?? randomUUID();
            let yaml, copiedFrom;
            if (command.operation === 'duplicate') {
                if (!previous || previous.id !== command.id)
                    throw new WorkflowRuntimeError('not-found');
                const original = this.replay(previous);
                if (id === original.id)
                    throw new WorkflowRuntimeError('conflict');
                if (original.generation !== command.expectedGeneration || !original.changes.some(c => ['create', 'accept', 'restore'].includes(c.operation) && 'revision' in c && c.revision === command.revision))
                    throw new WorkflowRuntimeError('conflict');
                yaml = original.revisions.find(item => item.revision === command.revision).yaml;
                copiedFrom = { id: original.id, generation: original.generation, revision: command.revision };
            }
            else
                yaml = command.yaml;
            const source = parseWorkflow(yaml, this.limits);
            record = { schemaVersion: 1, id, revisions: [{ revision: source.revision, yaml: source.yaml }], changes: [] };
            change = { operation: 'create', title: command.title, revision: source.revision, actor: command.actor, at: now,
                ...(copiedFrom ? { copiedFrom } : {}) };
        }
        else {
            if (!previous || previous.id !== command.id)
                throw new WorkflowRuntimeError('not-found');
            record = structuredClone(previous);
            const current = this.replay(record);
            if (current.generation !== command.expectedGeneration)
                throw new WorkflowRuntimeError('conflict');
            if (current.archived && !['archive', 'rename'].includes(command.operation))
                throw new WorkflowRuntimeError('archived');
            const head = { actor: command.actor, at: now < current.updatedAt ? current.updatedAt : now };
            if (command.operation === 'propose') {
                const source = parseWorkflow(command.yaml, this.limits);
                if (source.document.metadata.id !== current.workflowId)
                    throw new WorkflowRuntimeError('conflict');
                const proposalId = command.proposalId ?? randomUUID();
                if (current.proposals.some(p => p.id === proposalId))
                    throw new WorkflowRuntimeError('conflict');
                if (!record.revisions.some(item => item.revision === source.revision))
                    record.revisions.push({ revision: source.revision, yaml: source.yaml });
                change = { ...head, operation: 'propose', proposalId, base: current.acceptedRevision, revision: source.revision };
            }
            else if (command.operation === 'accept' || command.operation === 'reject') {
                const proposal = current.proposals.find(p => p.id === command.proposalId);
                if (!proposal || proposal.status !== 'pending' || proposal.revision !== command.reviewedRevision
                    || (command.operation === 'accept' && proposal.base !== current.acceptedRevision))
                    throw new WorkflowRuntimeError('conflict');
                change = command.operation === 'accept'
                    ? { ...head, operation: 'accept', proposalId: proposal.id, revision: proposal.revision, approvalChanges: command.approvalChanges }
                    : { ...head, operation: 'reject', proposalId: proposal.id, revision: proposal.revision };
            }
            else if (command.operation === 'restore') {
                if (!record.changes.some(c => ['create', 'accept', 'restore'].includes(c.operation) && 'revision' in c && c.revision === command.revision))
                    throw new WorkflowRuntimeError('conflict');
                change = { ...head, operation: 'restore', revision: command.revision, approvalChanges: command.approvalChanges };
            }
            else if (command.operation === 'rename')
                change = { ...head, operation: 'rename', title: command.title };
            else
                change = { ...head, operation: 'archive', archived: command.archived };
            if (change.operation === 'accept' || change.operation === 'restore') {
                if (!isDeepStrictEqual(change.approvalChanges, this.diff(record, current.acceptedRevision, change.revision).approvalChanges))
                    throw new WorkflowRuntimeError('conflict');
            }
        }
        record.changes.push(change);
        if (record.changes.length > 1000 || record.revisions.length > 100)
            throw new WorkflowRuntimeError('limit');
        const encoded = JSON.stringify(recordSchema.parse(record));
        if (Buffer.byteLength(encoded) > this.maxRecordBytes)
            throw new WorkflowRuntimeError('limit');
        const result = this.replay(record);
        return { record, project: result };
    }
}
