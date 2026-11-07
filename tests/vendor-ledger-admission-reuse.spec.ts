import { afterEach, describe, expect, it, vi } from 'vitest'
import * as workflow from '../src/workflow/index.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { previewVendorImport } from '../src/projects/vendor-import.ts'
import { ProjectLedger } from '../src/projects/ledger.ts'

const limits = DEFAULT_COMPILER_LIMITS.source
const source = JSON.stringify({ name: 'Replay admission',
  nodes: [{ name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }], connections: {} })
function fixture(edited = false) {
  const preview = previewVendorImport(source, limits)
  const yaml = edited ? preview.yaml.replace('Replay admission', 'Edited draft') : preview.yaml
  const command = { id: '00000000-0000-4000-8000-000000000002', title: 'Reviewed replay', actor: 'local:fixture',
    source, yaml, reviewedSourceSha256: preview.sourceSha256, reviewedConversionSha256: preview.conversionSha256,
    reviewedRevision: workflow.parseWorkflow(yaml, limits).revision }
  const ledger = new ProjectLedger(limits, 4_000_000)
  return { ledger, ...ledger.createVendorImport(command) }
}
afterEach(() => vi.restoreAllMocks())

describe('ledger-local retained vendor source admission', () => {
  it('reuses only the source admitted in this replay for identical original conversion text', () => {
    const f = fixture(), before = structuredClone(f.record), parse = vi.spyOn(workflow, 'parseWorkflow')
    expect(f.ledger.replay(f.record)).toEqual(f.project)
    expect(parse).toHaveBeenCalledTimes(1)
    expect(f.record).toEqual(before)
  })
  it('independently parses a distinct original conversion when creation was edited', () => {
    const f = fixture(true), before = structuredClone(f.record), parse = vi.spyOn(workflow, 'parseWorkflow')
    expect(f.ledger.replay(f.record)).toEqual(f.project)
    expect(parse).toHaveBeenCalledTimes(2)
    expect(f.record).toEqual(before)
  })
  it('admits every replay afresh and never transfers admission across changed owner budgets', () => {
    const f = fixture(), parse = vi.spyOn(workflow, 'parseWorkflow')
    expect(f.ledger.replay(f.record)).toEqual(f.project)
    expect(f.ledger.replay(f.record)).toEqual(f.project)
    expect(parse).toHaveBeenCalledTimes(2)
    expect(() => new ProjectLedger({ ...limits, maxNodes: 1 }, 4_000_000).replay(f.record)).toThrow()
  })
  it.each(['source', 'conversion', 'revision', 'request', 'actor', 'at', 'project', 'formatting'])(
    'keeps retained %s corruption checks despite reuse', field => {
      const f = fixture(), corrupted = structuredClone(f.record), record = corrupted.vendorImport!
      if (field === 'source') record.source += 'changed'
      else if (field === 'conversion') record.conversion.conversionSha256 = 'a'.repeat(64)
      else if (field === 'revision') record.revision = 'a'.repeat(64)
      else if (field === 'request') record.requestSha256 = 'a'.repeat(64)
      else if (field === 'actor') record.actor = 'local:forged'
      else if (field === 'at') record.at = '2026-01-01T00:00:00.000Z'
      else if (field === 'project') record.projectId = '00000000-0000-4000-8000-000000000003'
      else record.conversion.yaml = '# different bytes\n' + record.conversion.yaml
      expect(() => f.ledger.replay(corrupted)).toThrow('corrupt')
    })
  it('still admits every retained revision and refuses an unrelated corrupt revision', () => {
    const f = fixture()
    const proposed = f.ledger.apply({ operation: 'propose', id: f.project.id, expectedGeneration: 1, actor: 'local:fixture',
      yaml: f.record.revisions[0]!.yaml.replace('Replay admission', 'Proposed draft') }, f.record)
    const parse = vi.spyOn(workflow, 'parseWorkflow')
    expect(f.ledger.replay(proposed.record)).toEqual(proposed.project)
    expect(parse).toHaveBeenCalledTimes(2)
    const corrupted = structuredClone(proposed.record)
    corrupted.revisions[1]!.yaml += '\n!custom malformed'
    expect(() => f.ledger.replay(corrupted)).toThrow()
  })
})
