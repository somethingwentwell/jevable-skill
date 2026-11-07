import { PROTOCOL_VERSION } from "../capabilities.js";
import { releaseOperationJsonSchema } from "./service-session.js";
/** Static contract for the pinned owner API, with examples that never contain
 * a real token or release identity. Generated operation variants track Zod.
 */
export function releaseOpenApi(reviewerDecisions = false) {
    const command = structuredClone(releaseOperationJsonSchema());
    delete command.$schema;
    const rewrite = (value) => {
        if (!value || typeof value !== 'object')
            return;
        if (Array.isArray(value)) {
            for (const child of value)
                rewrite(child);
            return;
        }
        const item = value;
        if (typeof item.$ref === 'string' && item.$ref.startsWith('#/$defs/'))
            item.$ref = item.$ref.replace('#/$defs/', '#/components/schemas/ReleaseOperation/$defs/');
        for (const child of Object.values(item))
            rewrite(child);
    };
    for (const variant of command.oneOf) {
        variant.properties.releaseSha256 = { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Exact published release SHA-256.' };
        variant.required.push('releaseSha256');
    }
    rewrite(command);
    const protocol = { name: 'X-Jevable-Protocol', in: 'header', required: true,
        schema: { type: 'string', const: PROTOCOL_VERSION }, description: 'Pinned API protocol version.' };
    const error = { description: 'Refused or failed; a lost response does not prove an operation was not committed.', content: {
            'application/json': { schema: { type: 'object', required: ['status', 'code'],
                    properties: { status: { const: 'error' }, code: { type: 'string' } } } }
        } };
    const success = (description) => ({ description, content: { 'application/json': { schema: { type: 'object' } } } });
    return {
        openapi: '3.1.0', info: { title: 'Jevable published workflow API', version: PROTOCOL_VERSION,
            description: 'One immutable workflow release. The owner bearer token authorizes every release operation, including private reads and approvals. Retain run IDs before retrying uncertain requests.' },
        servers: [{ url: '/', description: 'The same origin as this published workflow app.' }],
        security: [{ ownerBearer: [] }],
        paths: {
            '/': { get: { summary: 'Open the inert operator page', security: [], responses: { '200': { description: 'No workflow or private data is included.' } } } },
            '/v1/openapi.json': { get: { summary: 'Read this owner-authenticated API contract', responses: { '200': success('OpenAPI 3.1 JSON.') } } },
            '/v1/capabilities': { get: { summary: 'Read runtime capabilities and exact release identity', responses: { '200': success('Capability metadata; no run is started.'), '401': error } } },
            '/v1/health': { get: { summary: 'Read runtime readiness without starting a run', parameters: [protocol],
                    responses: { '200': success('Readiness and active-request status.'), '401': error, '409': error } } },
            '/v1/operations': { post: { summary: 'Perform one exact-release owner operation', parameters: [protocol],
                    description: 'All operations require a matching releaseSha256 in the JSON body. A transport failure can leave an operation committed; inspect the same retained ID before retrying.',
                    requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ReleaseOperation' }, examples: {
                                    info: { summary: 'Read workflow identity and diagram', value: { operation: 'release.info', releaseSha256: '<64 lowercase hex characters>' } },
                                    run: { summary: 'Start a retained run', value: { operation: 'runs.start', releaseSha256: '<64 lowercase hex characters>', id: '<retained UUID>', input: 'Hello' } },
                                    runStatus: { summary: 'Read that same run', value: { operation: 'runs.show', releaseSha256: '<64 lowercase hex characters>', id: '<retained UUID>' } },
                                    approvals: { summary: 'Read the first waiting-decision page', value: { operation: 'approvals.list', releaseSha256: '<64 lowercase hex characters>', page: { limit: 100 } } },
                                } } } }, responses: { '200': success('An operation result in the result field.'), '400': error,
                        '401': error, '409': error, '413': error, '429': error } } },
            ...(reviewerDecisions ? {
                '/review': { get: { summary: 'Open the inert one-request reviewer page', security: [],
                        responses: { '200': { description: 'No bearer, release source or review data is included.' } } } },
                '/v1/reviewer/request': { post: { summary: 'Read only the exact live approval assigned to this reviewer grant',
                        security: [{ reviewerBearer: [] }], parameters: [protocol, { name: 'X-Jevable-Instance', in: 'header', required: true,
                                schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': {
                                    schema: { type: 'object', additionalProperties: false, properties: {} }
                                } } },
                        responses: { '200': success('One bounded review request; no run source or other approvals.'), '401': error, '404': error, '409': error } } },
                '/v1/reviewer/decisions': { post: { summary: 'Commit or observe the exact retained reviewer decision',
                        security: [{ reviewerBearer: [] }], parameters: [protocol, { name: 'X-Jevable-Instance', in: 'header', required: true,
                                schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': {
                                    schema: { type: 'object', additionalProperties: false, required: ['requestId', 'action'], properties: {
                                            requestId: { type: 'string', format: 'uuid' }, action: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,127}$',
                                                description: 'One action in the live reviewer grant and exact approval node; reserved route names are refused.' },
                                            pauseAfter: { type: 'boolean' }
                                        } }
                                } } },
                        responses: { '200': success('Metadata-only saved decision receipt.'), '401': error, '404': error, '409': error } } },
            } : {}),
        },
        components: { securitySchemes: { ownerBearer: { type: 'http', scheme: 'bearer', bearerFormat: '64 lowercase hex characters',
                    description: 'Supply Authorization: Bearer <owner token>. Never place it in a URL, workflow file or shared screenshot.' },
                ...(reviewerDecisions ? { reviewerBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'jvg1.<uuid>.<secret>',
                        description: 'One release, run, attempt and action subset. Never use as the owner bearer or place it in a URL.' } } : {}) },
            schemas: { ReleaseOperation: command } },
    };
}
