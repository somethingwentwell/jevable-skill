/** Detect, convert and admit one uploaded vendor workflow file; nothing is installed, fetched or executed. */
import { createHash } from 'node:crypto';
import { parseDocument, stringify } from 'yaml';
import { parseWorkflow } from "../source.js";
import { WorkflowImportError } from "../errors.js";
import { hasCredentials } from "../secrets.js";
import { convertN8n, isN8nWorkflow } from "./n8n.js";
import { DIFY_DSL_VERSIONS, convertDify, isDifyApp } from "./dify.js";
import { convertZapier, isZapierExport, zapierVersion } from "./zapier.js";
import { convertMake, isMakeBlueprint, makeVersion } from "./make.js";
import { convertPowerAutomate, powerAutomateFlow, powerAutomateVersion } from "./power-automate.js";
import { COZE_DSL_VERSIONS, convertCoze, cozeGraph } from "./coze.js";
/**
 * Convert one n8n editor JSON, Dify DSL YAML, Coze canvas JSON or workflow YAML, Zapier Zap export, Make blueprint or Power
 * Automate flow definition file into admitted Jevable YAML for review.
 * @param source - Uploaded file text.
 * @param limits - Source limits applied to the upload and to the converted draft.
 * @returns the converted YAML, report and source hash.
 * @throws WorkflowImportError for unknown formats, unsupported versions, recognizable credentials in the upload or drafts that
 * fail source admission.
 */
export function importWorkflow(source, limits) {
    return admitImportedWorkflow(source, limits).converted;
}
/** Internal operation-local admission, never exported by the public workflow SDK.
 * The trusted project adapter may supply its ordinary parser so the converter's
 * generated YAML admission also yields the immutable snapshot used for review.
 * There is no uploaded witness, retained cache or bypass of the caller's limits.
 */
export function admitImportedWorkflow(source, limits, readSource = parseWorkflow) {
    if (Buffer.byteLength(source, 'utf8') > limits.maxSourceBytes)
        throw new WorkflowImportError('too-large');
    const sourceSha256 = createHash('sha256').update(source).digest('hex');
    let value;
    try {
        const parsed = parseDocument(source, { schema: 'core', strict: true });
        if (parsed.errors.length)
            throw new Error('Invalid document');
        value = parsed.toJS({ maxAliasCount: 0 });
    }
    catch (_error) {
        throw new WorkflowImportError('unknown-format'); /* Neither JSON nor alias-free YAML; the text is never echoed. */
    }
    // The upload is kept with the project it creates, so a file carrying credentials is refused instead of stored.
    if (hasCredentials(value))
        throw new WorkflowImportError('secret-values');
    let result;
    const flow = powerAutomateFlow(value), coze = cozeGraph(value);
    if (isN8nWorkflow(value))
        result = convertN8n(value);
    else if (isDifyApp(value)) {
        if (!DIFY_DSL_VERSIONS.test(value.version))
            throw new WorkflowImportError('unsupported-version');
        result = convertDify(value);
    }
    else if (coze) {
        if (coze.form === 'dsl' && !COZE_DSL_VERSIONS.test(coze.version))
            throw new WorkflowImportError('unsupported-version');
        result = convertCoze(coze);
    }
    else if (isZapierExport(value)) {
        const version = zapierVersion(value);
        if (version === undefined)
            throw new WorkflowImportError('unsupported-version');
        result = convertZapier(value, version);
    }
    else if (isMakeBlueprint(value)) {
        if (makeVersion(value) === undefined)
            throw new WorkflowImportError('unsupported-version');
        result = convertMake(value);
    }
    else if (flow) {
        const version = powerAutomateVersion(flow);
        if (version === undefined)
            throw new WorkflowImportError('unsupported-version');
        result = convertPowerAutomate(flow, version);
    }
    else
        throw new WorkflowImportError('unknown-format');
    const { 'jevable.ai/import': record } = result.document.extensions;
    const yaml = stringify({ ...result.document, extensions: { 'jevable.ai/import': { ...record, sourceSha256 } } });
    let admitted;
    try {
        admitted = readSource(yaml, limits);
    }
    catch (_error) {
        throw new WorkflowImportError('invalid-draft'); /* The converted graph broke a source rule or limit. */
    }
    const converted = { format: result.format, version: result.version, title: result.title, yaml, sourceSha256, mappings: result.mappings };
    return { converted, admitted };
}
