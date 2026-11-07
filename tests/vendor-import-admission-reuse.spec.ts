import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import * as workflow from '../src/workflow/index.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { previewVendorImport, prepareVendorImport, verifyVendorImport } from '../src/projects/vendor-import.ts'
import { ProjectLedger } from '../src/projects/ledger.ts'

const limits = DEFAULT_COMPILER_LIMITS.source
const upload = JSON.stringify({ name: 'Reviewed admission', nodes: [{ name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }], connections: {} })
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function request(source = upload) {
  const preview = previewVendorImport(source, limits)
  return { id: '00000000-0000-4000-8000-000000000001', title: 'Stable review', actor: 'local:fixture', source, yaml: preview.yaml,
    reviewedSourceSha256: preview.sourceSha256, reviewedConversionSha256: preview.conversionSha256, reviewedRevision: preview.conversionRevision }
}
afterEach(() => vi.restoreAllMocks())
describe('operation-local canonical vendor admission reuse', () => {
  // Captured from the original implementation before the optimization. Cover all
  // public preview bytes and reviewed request identity, not just YAML equivalence.
  it.each([
    ['n8n-triage.json', '748f3117acd8d356581498c3280e6980678156c14bc4371861ed5e323c5ac977', 'f04bedaa0e01f519b82fa8f70732320866b5eb0aa517820c0786474e9ae47eb8'],
    ['dify-support.yml', '6ed2fec3c83e12313a0f477d4d1d17eca0d53279f0e62fc597f13d8c24d8a010', 'f2fdb6beb82f04ed4ffaac0079fa3f24d36a38f6d3161732f01df1c06a43081c'],
    ['coze-intent.json', 'c796376312a51748f240e3cfe9b5bc02c57e817cbb60a8bf429085309fe5fae6', '9b59078a751850dec806330df5d609e41becf0a4af96289863ab4392f9330a4e'],
    ['zapier-support.json', '85c562f2722e2dcb0613edecea6b3108f9d578be5ff18f684d59044af858538b', '5d46eb6025035edbbfd363eec05b862a3fa05d30d6fd0d9704d5172e220e251b'],
    ['make-support.json', 'dc81f57456e7e928a7db76a3bf1385a3b8d762c0bfcc92926a8d361fa2d10a05', 'e7a634ecf5a72f3e5e08b1968d90e4a14268828902d159bc4f22f2d7186f249d'],
    ['power-automate-tickets.json', 'fec4c73917e226ee48bec7b70f54e55dfb13f63be2f6427fab96b8ddb7c09eb6', '7f6c9f57446f501f8da8fbe50f6780cc9f69acafba5363df9044d8df839abc16'],
  ])('preserves complete preview and request bytes for %s', async (file, previewHash, requestHash) => {
    const source = await readFile(new URL(`workflow/fixtures/import/${file}`, import.meta.url), 'utf8')
    expect(hash(previewVendorImport(source, limits))).toBe(previewHash)
    expect(prepareVendorImport(request(source), limits).requestSha256).toBe(requestHash)
  })
  it('uses one preview admission for an exact canonical draft without exposing a witness', () => {
    const command = request(), before = structuredClone(command), parse = vi.spyOn(workflow, 'parseWorkflow')
    const prepared = prepareVendorImport(command, limits)
    expect(parse).toHaveBeenCalledTimes(1) // Converter's own separate source admission remains intact.
    expect(prepared.command).toEqual(before); expect(command).toEqual(before)
    expect(Object.keys(prepared.conversion)).not.toContain('admitted')
  })
  it('still parses a reformatted but equivalent draft and produces the same request identity', () => {
    const command = request(), exact = prepareVendorImport(command, limits), parse = vi.spyOn(workflow, 'parseWorkflow')
    expect(prepareVendorImport({ ...command, yaml: '# reviewed formatting\n' + command.yaml }, limits)).toEqual(exact)
    expect(parse).toHaveBeenCalledTimes(2)
  })
  it('parses an edited draft independently and enforces its reviewed hash and workflow identity', () => {
    const command = request(), yaml = command.yaml.replace('Reviewed admission', 'Edited display name'), revision = workflow.parseWorkflow(yaml, limits).revision
    const parse = vi.spyOn(workflow, 'parseWorkflow')
    expect(prepareVendorImport({ ...command, yaml, reviewedRevision: revision }, limits).command.reviewedRevision).toBe(revision)
    expect(parse).toHaveBeenCalledTimes(2)
    expect(() => prepareVendorImport({ ...command, yaml }, limits)).toThrow('conflict')
    const document = structuredClone(workflow.parseWorkflow(command.yaml, limits).document)
    const foreign = workflow.snapshotWorkflow({ ...document, metadata: { ...document.metadata, id: 'different-workflow' } }, limits)
    expect(() => prepareVendorImport({ ...command, yaml: foreign.yaml, reviewedRevision: foreign.revision }, limits)).toThrow('conflict')
  })
  it.each(['!custom untrusted', 'x: &alias [1]\ny: *alias', 'kind: Workflow\nkind: Workflow'])('never treats changed malformed text as the existing admission', yaml => {
    expect(() => prepareVendorImport({ ...request(), yaml }, limits)).toThrow()
  })
  it('does not reuse an admission across requests or changed owner limits', () => {
    const command = request(), parse = vi.spyOn(workflow, 'parseWorkflow')
    prepareVendorImport(command, limits); prepareVendorImport(command, limits)
    expect(parse).toHaveBeenCalledTimes(2)
    expect(() => prepareVendorImport(command, { ...limits, maxNodes: 1 })).toThrow()
  })
  it('verifies identical retained draft/conversion once, while detecting altered retained data', () => {
    const created = new ProjectLedger(limits, 4_000_000).createVendorImport(request())
    const record = created.record.vendorImport!, first = created.record.changes[0]!, yaml = created.record.revisions[0]!.yaml
    const parse = vi.spyOn(workflow, 'parseWorkflow')
    verifyVendorImport(record, created.project.id, first, yaml, limits)
    expect(parse).toHaveBeenCalledTimes(1)
    const forged = structuredClone(record); forged.conversion.yaml += '\n'
    expect(() => verifyVendorImport(forged, created.project.id, first, yaml, limits)).toThrow('corrupt')
    expect(() => verifyVendorImport(record, created.project.id, first, yaml, { ...limits, maxNodes: 1 })).toThrow('corrupt')
  })
  it('verifies both distinct sources when an edited creation differs from the retained conversion', () => {
    const command = request(), yaml = command.yaml.replace('Reviewed admission', 'Edited display name'), reviewedRevision = workflow.parseWorkflow(yaml, limits).revision
    const created = new ProjectLedger(limits, 4_000_000).createVendorImport({ ...command, yaml, reviewedRevision })
    const parse = vi.spyOn(workflow, 'parseWorkflow')
    verifyVendorImport(created.record.vendorImport!, created.project.id, created.record.changes[0]!, created.record.revisions[0]!.yaml, limits)
    expect(parse).toHaveBeenCalledTimes(2)
  })
})
