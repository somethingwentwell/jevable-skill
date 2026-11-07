import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileWorkflow, DEFAULT_COMPILER_LIMITS, listTemplates, renderTemplate, validateSource, validateWorkflowValue } from '../src/index.ts'
import { main } from '../src/cli.ts'
import { writeArtifact, readBoundedFile } from '../src/files.ts'

async function cli(args: string[]) {
  let stdout = '', stderr = ''
  const code = await main(args, { out: value => { stdout += value }, err: value => { stderr += value } })
  return { code, stdout, stderr }
}

describe('standalone authoring core', () => {
  it('compiles every template in both languages, with matching input samples', () => {
    for (const language of ['en', 'zh'] as const) {
      const templates = listTemplates(language)
      expect(templates).toHaveLength(10)
      for (const template of templates) {
        expect(template.description).not.toBe('')
        expect(template.title).not.toBe(template.id)
        const graph = compileWorkflow(renderTemplate(template.id, { language, model: { provider: 'fixture', model: 'fixture' } }), DEFAULT_COMPILER_LIMITS)
        expect(graph.source.document.metadata.name).toBe(template.title)
        expect(Object.isFrozen(graph)).toBe(true)
        expect(validateWorkflowValue(graph.input, template.sample, DEFAULT_COMPILER_LIMITS.binding.data)).toEqual(template.sample)
      }
    }
  })

  it('does not invent a configured AI model', () => {
    expect(() => renderTemplate('support-reply')).toThrow('requires an explicit provider and model')
    expect(() => renderTemplate('discount-approval')).not.toThrow()
  })

  it('distinguishes invalid source from valid but unexecuted source', () => {
    expect(validateSource('not a workflow')).toMatchObject({ status: 'invalid', execution: 'not-run' })
    expect(validateSource(JSON.stringify(renderTemplate('discount-approval')))).toMatchObject({ status: 'valid', runtimeReadiness: 'not-checked', execution: 'not-run' })
  })

  it('renders through the CLI and validates the exact on-disk revision', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jevable-cli-test-'))
    const output = join(dir, 'discount.yaml')
    const rendered = await cli(['templates', 'render', 'discount-approval', '--output', output, '--json'])
    expect(rendered.code).toBe(0)
    const receipt = JSON.parse(rendered.stdout)
    const checked = await cli(['validate', output, '--json'])
    expect(checked.code).toBe(0)
    expect(JSON.parse(checked.stdout).revision).toBe(receipt.revision)
    expect(receipt.artifact.bytes).toBe(Buffer.byteLength(await readFile(output, 'utf8')))
    const again = await cli(['templates', 'render', 'discount-approval', '--output', output])
    expect(again.code).toBe(1)
    expect(again.stderr).toContain('Output exists')
  })

  it('refuses unknown operations and silently ignored runtime flags', async () => {
    for (const input of [['run', 'a.yaml'], ['validate', 'a.yaml', '--runtime', 'docker'], ['doctor', 'extra'], ['templates', 'list', '--language', 'fr']]) {
      expect((await cli(input)).code).toBe(2)
    }
  })

  it('does not expose model credentials or YAML source in errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jevable-invalid-'))
    const file = join(dir, 'invalid.yaml')
    await writeArtifact(file, 'secret: very-private-key\n')
    const result = await cli(['validate', file, '--json'])
    expect(result.code).toBe(2)
    expect(result.stdout + result.stderr).not.toContain('very-private-key')
  })

  it('bounds reads and refuses existing destinations without following symlinks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jevable-files-'))
    const original = join(dir, 'original.txt'), alias = join(dir, 'alias.txt')
    await writeArtifact(original, 'keep')
    await symlink(original, alias)
    await expect(writeArtifact(alias, 'replace')).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(original, 'utf8')).toBe('keep')
    await writeArtifact(alias, 'new', true)
    expect(await readFile(original, 'utf8')).toBe('keep')
    expect(await readFile(alias, 'utf8')).toBe('new')
    await expect(readBoundedFile(original, 3)).rejects.toThrow('byte limit')
    expect(await readBoundedFile(original, 4)).toBe('keep')
    await expect(readBoundedFile(dir, 100)).rejects.toThrow('regular input file')
  })

  it('reports conversion gaps without executing the imported workflow', async () => {
    const result = await cli(['import', 'preview', new URL('./workflow/fixtures/import/n8n-assistant.json', import.meta.url).pathname, '--json'])
    expect(result.code).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.status).toBe('review-required')
    expect(report.execution).toBe('not-run')
    expect(report.mappings.some((entry: { kind: string }) => entry.kind === 'unsupported')).toBe(true)
    expect(report.validation.status).toBe('invalid')
  })
})
