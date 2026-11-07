import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import * as yaml from 'yaml'
import * as workflow from '../src/workflow/index.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { previewVendorImport, prepareVendorImport } from '../src/projects/vendor-import.ts'

// Preserve real YAML behavior while making the external ESM exports observable.
vi.mock('yaml', { spy: true })
const limits = DEFAULT_COMPILER_LIMITS.source
const upload = JSON.stringify({ name: 'Converter admission', nodes: [{ name: 'Start',
  type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }], connections: {} })
const request = () => {
  const preview = previewVendorImport(upload, limits)
  return { id: '00000000-0000-4000-8000-000000000001', title: 'Converter admission', actor: 'local:fixture', source: upload,
    yaml: preview.yaml, reviewedSourceSha256: preview.sourceSha256, reviewedConversionSha256: preview.conversionSha256,
    reviewedRevision: preview.conversionRevision }
}
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })
const observeParses = () => {
  const parse = vi.mocked(yaml.parseDocument)
  parse.mockClear() // Fixture preparation is outside the measured operation.
  return parse
}

describe('converter-owned operation-local source admission', () => {
  // Full public import result hashes captured before this optimization. This
  // includes original noncanonical YAML bytes, source hash and ordered mappings.
  it.each([
    ['n8n-triage.json', '7b53ec15ac841bb2ab3dcbd2fa11f67a731e0324821584679be2ff14ea9397c8'],
    ['dify-support.yml', 'a7aeaaa6a9212768a30db4ae25066f4de0e50213f622d4e5385a04c5c50f8371'],
    ['coze-intent.json', 'dd662d45658bbfed8cb643ffceeecabe1d5963a707ca35f555005fab0bd002d0'],
    ['zapier-support.json', 'f9279cd4be39fa2e694dc2620fc31ff8afe31ec590f3c0e19517c0b1c7b0f283'],
    ['make-support.json', '20cbe595bd91014859693bf4426603fa690297fc036f8d6e99061d8024f92a55'],
    ['power-automate-tickets.json', '387977aa24663384d7dc1821da8fb09cc4bc7105ae4592cdea4a6659f438ac5e'],
  ])('preserves all public import bytes for %s', async (file, hash) => {
    const source = await readFile(new URL(`workflow/fixtures/import/${file}`, import.meta.url), 'utf8')
    expect(createHash('sha256').update(JSON.stringify(workflow.importWorkflow(source, limits))).digest('hex')).toBe(hash)
  })
  it('parses the upload and generated draft once each for a private review', () => {
    const parse = observeParses(), result = previewVendorImport(upload, limits)
    expect(parse).toHaveBeenCalledTimes(2)
    expect(result.yaml).toBe(workflow.parseWorkflow(result.yaml, limits).yaml)
    expect(Object.keys(result)).not.toContain('admitted')
  })
  it('preserves independent admission in the public converter and exports no witness', () => {
    const parse = observeParses(), result = workflow.importWorkflow(upload, limits)
    expect(parse).toHaveBeenCalledTimes(2)
    expect(Object.keys(result).sort()).toEqual(['format', 'mappings', 'sourceSha256', 'title', 'version', 'yaml'])
    expect(workflow).not.toHaveProperty('admitImportedWorkflow')
  })
  it('reuses only the generated canonical draft within the current preparation', () => {
    const command = request(), before = structuredClone(command), parse = observeParses()
    const prepared = prepareVendorImport(command, limits)
    expect(parse).toHaveBeenCalledTimes(2)
    expect(prepared.command).toEqual(before); expect(command).toEqual(before)
    expect(prepared.conversion).not.toHaveProperty('admitted')
  })
  it('still independently admits equivalent but reformatted review text', () => {
    const command = request(), exact = prepareVendorImport(command, limits), parse = observeParses()
    expect(prepareVendorImport({ ...command, yaml: '# edited formatting\n' + command.yaml }, limits)).toEqual(exact)
    expect(parse).toHaveBeenCalledTimes(3)
  })
  it('still independently admits edited review text and its exact revision', () => {
    const command = request(), text = command.yaml.replace('Converter admission', 'Changed name')
    const revision = workflow.parseWorkflow(text, limits).revision, parse = observeParses()
    expect(prepareVendorImport({ ...command, yaml: text, reviewedRevision: revision }, limits).command.reviewedRevision).toBe(revision)
    expect(parse).toHaveBeenCalledTimes(3)
    expect(() => prepareVendorImport({ ...command, yaml: text }, limits)).toThrow('conflict')
  })
  it('does not retain admission across requests, owner budgets or modified uploads', () => {
    const command = request(), parse = observeParses()
    prepareVendorImport(command, limits); prepareVendorImport(command, limits)
    expect(parse).toHaveBeenCalledTimes(4)
    expect(() => prepareVendorImport(command, { ...limits, maxNodes: 1 })).toThrow()
    expect(() => prepareVendorImport({ ...command, source: upload.replace('Converter admission', 'Different upload') }, limits)).toThrow('conflict')
  })
  it.each(['admitted', 'snapshot', 'witness'])('refuses caller-supplied %s authority before conversion', field => {
    const command = request(), parse = observeParses()
    expect(() => prepareVendorImport({ ...command, [field]: { yaml: command.yaml, revision: command.reviewedRevision } }, limits)).toThrow('invalid-command')
    expect(parse).not.toHaveBeenCalled()
  })
})
