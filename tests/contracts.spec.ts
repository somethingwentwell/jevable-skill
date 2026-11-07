import { describe, expect, it } from 'vitest'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { listSchemas, showSchema, SchemaDiscoveryError } from '../src/contracts.ts'
import { workflowSchema } from '../src/workflow/schema.ts'
import { approvalConfig, triggerConfig, decisionConfig } from '../src/workflow/node-config.ts'
import { testDefinitionSchema } from '../src/testing/schema.ts'
import { connectionSchema } from '../src/providers/config.ts'
import { telemetryConfigSchema } from '../src/telemetry/config.ts'
import { notificationConfigSchema } from '../src/notifications/config.ts'
import { evidenceSelectionSchema } from '../src/evidence/package.ts'
import { usageSelectionSchema, inspectUsageSelection } from '../src/evidence/usage.ts'
import { postgresConfigSchema, parsePostgresConfiguration } from '../src/storage/postgres-config.ts'
import { testSuiteSchema } from '../src/testing/suite.ts'
import { breakpointListSchema } from '../src/runtime/control.ts'
import { runtimeOperationSchema } from '../src/http/operations.ts'
import { callerControlRequestSchema } from '../src/access/caller-control.ts'
import { capabilities } from '../src/capabilities.ts'
import { renderTemplate, listTemplates } from '../src/templates/index.ts'

const ajv = new Ajv2020({ strict: false, validateFormats: false })
const validate = (id: string) => ajv.compile(showSchema(id).schema)
const uuid = 'ea953a2f-2d9c-42ad-9910-9c4fb2708d21', hash = 'a'.repeat(64)
const pin = { id: uuid, generation: 1, revision: hash }, identity = { id: uuid, generation: 1, sha256: hash }
const definition = { title: 'Fixture', project: pin, input: { message: 'private' }, expectations: [{ kind: 'status', value: 'completed' }] }

describe('offline shared input contract catalogue', () => {
  it.each(listSchemas().schemas)('emits compilable deterministic Draft 2020-12 input schema for $id', entry => {
    const a = showSchema(entry.id), b = showSchema(entry.id)
    expect(a).toEqual(b)
    expect(a).toMatchObject({ schemaVersion: 1, kind: 'schema', execution: 'not-dispatched', validation: 'structural-input-projection-only' })
    expect(a.schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(a.sha256).toBe(createHash('sha256').update(JSON.stringify(a.schema)).digest('hex'))
    expect(a.limits.length).toBeGreaterThan(40)
    expect(ajv.compile(a.schema)(undefined)).toBe(false)
  })

  it('has a stable unique catalogue with no source paths and detached metadata', () => {
    const a = listSchemas(), baseline = listSchemas()
    expect(a.schemas).toHaveLength(38)
    expect(new Set(a.schemas.map(x => x.id)).size).toBe(38)
    expect(JSON.stringify(a)).not.toContain(process.cwd())
    a.schemas[0]!.references.push('attacker'); a.notes.push('attacker'); a.schemas[0]!.limits = 'attacker'
    expect(listSchemas()).toEqual(baseline)
    const shown = showSchema('test-definition'), expected = showSchema('test-definition')
    shown.schema.properties!.title = {}; shown.notes.push('attacker'); shown.references.push('attacker')
    expect(showSchema('test-definition')).toEqual(expected)
  })

  it.each(['__proto__', 'constructor', 'toString', '../private.json', 'provider-connection ', '', 'unknown', null, 1])('refuses unknown/inherited schema ID %s without echo', id => {
    expect(() => showSchema(id as string)).toThrow(SchemaDiscoveryError)
    expect(() => showSchema(id as string)).toThrow('Unknown schema. Use schemas list.')
  })

  it('matches real input schemas, including transformed approval duration rather than milliseconds', () => {
    expect(showSchema('workflow').schema).toEqual(z.toJSONSchema(workflowSchema, { io: 'input', target: 'draft-2020-12', unrepresentable: 'throw' }))
    expect(showSchema('provider-connection').schema).toEqual(z.toJSONSchema(connectionSchema, { io: 'input', target: 'draft-2020-12', unrepresentable: 'throw' }))
    const value = { title: 'Review', input: {}, inputSchema: {}, actions: ['approve', 'reject'], expiresAfter: '2m', onReject: 'cancelled', onTimeout: 'expired' }
    const check = validate('node-approval')
    expect(check(value)).toBe(true); expect(approvalConfig.parse(value).expiresAfter).toBe(120000)
    expect(check({ ...value, expiresAfter: 120000 })).toBe(false)
    expect(value.expiresAfter).toBe('2m')
  })

  it.each(listTemplates())('admits actual shared template $id envelopes and node configurations', template => {
    const draft = renderTemplate(template.id, { model: { provider: 'fixture', model: 'fixture' } })
    expect(validate('workflow')(draft)).toBe(true)
    expect(workflowSchema.safeParse(draft).success).toBe(true)
    for (const node of Object.values(workflowSchema.parse(draft).spec.nodes)) {
      const id = node.type === 'humanApproval' ? 'node-approval' : `node-${node.type}`
      expect(validate(id)(node.config)).toBe(true)
    }
  })

  it('admits real test/control/configuration shapes and refuses unknown structure', () => {
    for (const [id, value] of [
      ['test-definition', definition], ['test-identity', identity],
      ['suite-selection', { title: 'Fixture', failurePolicy: 'stop', tests: [identity] }],
      ['suite-manifest', { schemaVersion: 1, kind: 'JevableTestSuite', title: 'Fixture', failurePolicy: 'stop', entries: [{ test: identity, runId: uuid }] }],
      ['evidence-selection', { schemaVersion: 1, runs: [{ id: uuid, revision: hash }] }],
      ['execution-control', { requestId: uuid, expectedCheckpointSha256: hash, mode: 'recover' }],
      ['runtime-operation', { operation: 'tests.run', test: identity, runId: uuid }],
      ['project-command', { operation: 'create', title: 'Fixture', yaml: 'not compiled here', actor: 'fixture' }],
      ['telemetry-config', { endpoint: 'https://collector.invalid/v1/traces', authentication: { kind: 'none' } }],
      ['telemetry-config', { endpoint: 'https://collector.invalid/v1/traces', authentication: { kind: 'none' }, httpRequests: false, httpConnections: true }],
      ['notification-config', {}],
    ] as const) {
      const check = validate(id)
      expect(check(value), id).toBe(true)
      expect(check({ ...value, privateUnknownProperty: 'never accepted' }), id).toBe(false)
    }
  })

  it('does not pretend omitted refinements are structural admission or mutate default input', () => {
    const telemetry = { authentication: { kind: 'none' } }
    expect(validate('telemetry-config')(telemetry)).toBe(true)
    expect(telemetryConfigSchema.safeParse(telemetry).success).toBe(false)
    expect(telemetry).toEqual({ authentication: { kind: 'none' } })
    const invalidTest = { ...definition, expectations: [...definition.expectations, ...definition.expectations] }
    expect(validate('test-definition')(invalidTest)).toBe(true); expect(testDefinitionSchema.safeParse(invalidTest).success).toBe(false)
    const duplicateRuns = { schemaVersion: 1, runs: [{ id: uuid, revision: hash }, { id: uuid, revision: hash }] }
    expect(validate('evidence-selection')(duplicateRuns)).toBe(true); expect(evidenceSelectionSchema.safeParse(duplicateRuns).success).toBe(false)
    const suite = { schemaVersion: 1, kind: 'JevableTestSuite', title: 'Fixture', failurePolicy: 'stop', entries: [{ test: identity, runId: uuid }, { test: identity, runId: uuid }] }
    expect(validate('suite-manifest')(suite)).toBe(true); expect(testSuiteSchema.safeParse(suite).success).toBe(false)
    expect(validate('breakpoints')(['start', 'start'])).toBe(true); expect(breakpointListSchema.safeParse(['start', 'start']).success).toBe(false)
    expect(validate('node-trigger')({ modes: ['manual', 'manual'] })).toBe(true); expect(triggerConfig.safeParse({ modes: ['manual', 'manual'] }).success).toBe(false)
    expect(validate('notification-config')({})).toBe(true); expect(notificationConfigSchema.parse({}).endpoints).toEqual([])
    expect(showSchema('node-custom').limits).toContain('unsupported')
  })

  it('keeps runtime operation nested semantic checks separate and preserves parser rejection', () => {
    const value = { operation: 'providers.set', connection: { arbitrary: true }, expectedGeneration: 0 }
    expect(validate('runtime-operation')(value)).toBe(true); expect(runtimeOperationSchema.safeParse(value).success).toBe(true)
    expect(connectionSchema.safeParse(value.connection).success).toBe(false)
    expect(showSchema('runtime-operation').limits).toContain('consuming validators')
    expect(validate('runtime-operation')({ operation: 'not-supported' })).toBe(false)
    const decision = { provider: 'llm', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' }, state: {},
      questions: { label: { type: 'noul', instructions: 'Judge' } }, execution: { timeoutSeconds: 30, maxAttempts: 1 } }
    expect(validate('node-decision')(decision)).toBe(true); expect(decisionConfig.safeParse(decision).success).toBe(false)
  })

  it('discovers the consuming strict caller control input without enabling an owner or transport action', () => {
    expect(showSchema('caller-control').schema).toEqual(z.toJSONSchema(callerControlRequestSchema, { io: 'input', target: 'draft-2020-12' }))
    const value = { requestId: uuid.toUpperCase(), mode: 'step', expectedCheckpointSha256: hash, breakpoints: [] }
    expect(validate('caller-control')(value)).toBe(true)
    expect(callerControlRequestSchema.parse(value)).toEqual({ ...value, requestId: uuid })
    for (const key of ['actor', 'at', 'delegation', 'scope', 'grantId', 'traceParent', 'input', 'output']) {
      expect(validate('caller-control')({ ...value, [key]: 'forged' })).toBe(false)
      expect(callerControlRequestSchema.safeParse({ ...value, [key]: 'forged' }).success).toBe(false)
    }
    expect(runtimeOperationSchema.safeParse({ operation: 'caller.control', id: uuid, request: value }).success).toBe(false)
    const sdk = capabilities().workflowRuntime.delegatedGrants.callerSdk
    expect(sdk.operations).toContain('controlCheckpointWithGrant'); expect(sdk.operations).toContain('advanceWithGrant')
    expect(sdk.controlTransport).toBe(true); expect(sdk.transportQualification).toBe(false); expect(sdk.reviewerDecision).toBe(false)
    expect(sdk.read).toBe('own-run-completed-output-only')
  })

  it('projects the shared usage validator without replacing ordered-window and unique-pin admission', () => {
    expect(showSchema('usage-selection').schema).toEqual(z.toJSONSchema(usageSelectionSchema, { io: 'input', target: 'draft-2020-12' }))
    const value = { schemaVersion: 1, runs: [{ id: uuid, revision: hash }],
      window: { from: '2020-01-01T00:00:00.000Z', before: '2020-01-02T00:00:00.000Z' }, groupBy: 'provider-model' }
    const check = validate('usage-selection')
    expect(check(value)).toBe(true); expect(inspectUsageSelection(value).selection).toEqual(value)
    expect(validate('evidence-selection')(value)).toBe(false)
    for (const invalid of [{ ...value, runs: [] }, { ...value, runs: [{ id: uuid, revision: 'not-a-hash' }] },
      { ...value, groupBy: 'model' }, { ...value, window: { ...value.window, unknown: true } }]) {
      expect(check(invalid)).toBe(false); expect(() => inspectUsageSelection(invalid)).toThrow()
    }
    for (const invalid of [{ ...value, runs: [value.runs[0], { id: uuid.toUpperCase(), revision: hash }] },
      { ...value, window: { ...value.window, before: value.window.from } }]) {
      expect(check(invalid)).toBe(true); expect(() => inspectUsageSelection(invalid)).toThrow()
    }
    const input = { schemaVersion: 1, runs: [{ id: uuid, revision: hash }] }, inspected = inspectUsageSelection(input)
    expect(inspected.sha256).toBe(createHash('sha256').update(JSON.stringify(input)).digest('hex'))
    input.runs[0]!.revision = 'b'.repeat(64)
    expect(inspected.selection.runs[0]!.revision).toBe(hash)
  })

  it('projects driver-free database configuration without leaking values or claiming TLS/readiness admission', () => {
    expect(showSchema('postgres-config').schema).toEqual(z.toJSONSchema(postgresConfigSchema, { io: 'input', target: 'draft-2020-12' }))
    const value = { host: '127.0.0.1', port: 5432, database: 'fixture', user: 'fixture', password: 'PRIVATE_PASSWORD',
      namespace: 'fixture', initialize: false, tls: { mode: 'loopback-test' } }
    const check = validate('postgres-config'), before = structuredClone(value)
    expect(check(value)).toBe(true)
    expect(value).toEqual(before)
    expect(parsePostgresConfiguration(value)).toMatchObject({ maxRecordBytes: 4_000_000, statementTimeoutMs: 5000 })
    expect(value).toEqual(before)
    expect(JSON.stringify(showSchema('postgres-config'))).not.toContain(value.password)
    for (const invalid of [{ ...value, host: 'remote.invalid' }, { ...value, tls: { mode: 'verify-full', ca: 'PRIVATE_INVALID_CA' } }]) {
      expect(check(invalid)).toBe(true)
      expect(() => parsePostgresConfiguration(invalid)).toThrow('invalid-config')
    }
    for (const invalid of [{ ...value, password: '' }, { ...value, tls: { mode: 'verify-full', rejectUnauthorized: false } },
      { ...value, connectionString: 'PRIVATE_CONNECTION' }, { ...value, statementTimeoutMs: 99 }]) {
      expect(check(invalid)).toBe(false); expect(() => parsePostgresConfiguration(invalid)).toThrow('invalid-config')
    }
  })
})
