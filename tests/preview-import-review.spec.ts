import { describe, expect, it, vi } from 'vitest'
import { readFile, mkdtemp, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { JSDOM } from 'jsdom'
import * as preview from '../src/preview/index.ts'
import { main } from '../src/cli.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'

const uploadPath = new URL('../examples/import-support/n8n.json', import.meta.url).pathname
const upload = () => readFile(uploadPath, 'utf8')
const cli = async (args: string[]) => {
  const out = vi.fn(), err = vi.fn(), code = await main(args, { out, err })
  return { code, out: out.mock.calls.flat().join(''), err: err.mock.calls.flat().join('') }
}
const render = preview.renderVendorImportPreview
describe('offline imported-workflow visual review', () => {
  it('keeps conversion mappings and exact draft identity beside the graph, with honest readiness', async () => {
    const result = render(await upload()), dom = new JSDOM(result.html).window.document
    expect(result.data.execution).toBe('not-run'); expect(result.data.runtimeReadiness).toBe('not-checked')
    expect(result.conversion.conversionRevision).toBe(result.data.revision)
    expect(dom.querySelector('#import-review')?.textContent).toContain('2 exact · 2 approximate · 0 unsupported')
    expect(dom.querySelector('#import-review')?.textContent).toContain('Review the conversion before testing')
    expect(dom.querySelector('#import-review')?.textContent).toContain('Custom code does not execute')
    expect(dom.querySelector('#import-review')?.textContent).toContain('not proof of equivalent source-platform behavior')
    expect(dom.querySelectorAll('[data-import-mapping]')).toHaveLength(result.conversion.mappings.length)
    for (const row of result.conversion.mappings) {
      expect(dom.querySelector('#import-review')?.textContent).toContain(row.source)
      if (row.target) expect(dom.querySelector('#import-review')?.textContent).toContain(row.target)
    }
    expect(result.html.indexOf('id="import-review"')).toBeLessThan(result.html.indexOf('aria-label="Workflow graph"'))
  })
  it('never includes upload-only data, claims origin authority, or adds network/storage/execution controls', async () => {
    const source = JSON.stringify({ ...JSON.parse(await upload()), privateMemo: 'RAW-UPLOAD-ONLY-MARKER' })
    const result = render(source), dom = new JSDOM(result.html).window.document
    expect(result.html).not.toContain('RAW-UPLOAD-ONLY-MARKER')
    expect(dom.querySelector('#import-review')?.textContent).toContain('No project was created')
    expect(dom.querySelector('#import-review')?.textContent).toContain('report and converted workflow are private authoring content')
    expect(dom.querySelector('#import-review')?.querySelectorAll('button, input, form, a')).toHaveLength(0)
    expect(result.html).toContain("connect-src &#39;none&#39;")
    expect(result.html).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/)
  })
  it('escapes malicious source labels and pins the complete style/script under CSP', async () => {
    const doc = JSON.parse(await upload()), hostile = '</script><img src=x onerror="globalThis.pwned=1">&'
    doc.nodes[1].name = hostile
    const result = render(JSON.stringify(doc)), dom = new JSDOM(result.html).window.document
    expect(dom.querySelectorAll('img')).toHaveLength(0)
    expect(dom.querySelector('#import-review')?.textContent).toContain(hostile)
    for (const tag of ['style', 'script:not([type])']) {
      const values = dom.querySelectorAll(tag); expect(values).toHaveLength(tag === 'style' ? 1 : 2)
      for (const value of values) {
        const hash = createHash('sha256').update(value.textContent!).digest('base64')
        expect(dom.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain(`sha256-${hash}`)
      }
    }
  })
  it.each(['n8n-triage.json', 'dify-support.yml', 'coze-intent.json', 'zapier-support.json', 'make-support.json', 'power-automate-tickets.json'])(
    'represents actual supported converter %s without vendor execution', async file => {
      const result = render(await readFile(new URL(`workflow/fixtures/import/${file}`, import.meta.url), 'utf8'))
      expect(result.conversion.mappings.length).toBeGreaterThan(0)
      expect(result.data.revision).toBe(result.conversion.conversionRevision)
      expect(result.html).toContain('No project was created')
    })
  it('writes HTML only on explicit format selection and keeps existing YAML output unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jevable-import-review-')), html = join(dir, 'review.html'), yaml = join(dir, 'draft.yaml')
    const result = await cli(['import', 'preview', uploadPath, '--output-format', 'html', '--output', html, '--json'])
    expect(result.code).toBe(0); expect(result.err).toBe('')
    expect(JSON.parse(result.out)).toMatchObject({ status: 'review-required', outputFormat: 'html', execution: 'not-run' })
    expect(await readFile(html, 'utf8')).toContain('id="import-review"')
    expect((await cli(['import', 'preview', uploadPath, '--output', yaml, '--json'])).code).toBe(0)
    expect(await readFile(yaml, 'utf8')).toBe(render(await upload()).conversion.yaml)
    const before = await readFile(html)
    expect((await cli(['import', 'preview', uploadPath, '--output-format', 'html', '--output', html])).code).toBe(1)
    expect(await readFile(html)).toEqual(before)
  })
  it.each(['pdf', 'HTML', ''])('refuses unknown output format %s before reading the vendor file or writing output', async format => {
    const dir = await mkdtemp(join(tmpdir(), 'jevable-import-review-refusal-')), output = join(dir, 'never-written')
    const result = await cli(['import', 'preview', '/never-read-vendor.json', '--output-format', format, '--output', output])
    expect(result.code).toBe(2); expect(result.err).toContain('output-format')
    await expect(access(output)).rejects.toThrow()
  })
  it('requires an output for explicit HTML and reflects finite choices in read-only help', async () => {
    const invalid = await cli(['import', 'preview', '/never-read-vendor.json', '--output-format', 'html'])
    expect(invalid.code).toBe(2); expect(invalid.err).toContain('--output')
    const help = await cli(['help', 'import', 'preview', '--json'])
    expect(help.code).toBe(0); expect(help.out).toContain('output-format'); expect(help.out).toContain('html')
  })
  it('retains converter credential and configured byte-budget refusal without a rendering fallback', async () => {
    const doc = { ...JSON.parse(await upload()), apiKey: 'PRIVATE_EMBEDDED_CREDENTIAL' }
    expect(() => render(JSON.stringify(doc))).toThrow('secret-values')
    expect(() => render('not a vendor document')).toThrow()
    const limits = { ...DEFAULT_COMPILER_LIMITS, source: { ...DEFAULT_COMPILER_LIMITS.source, maxSourceBytes: 10 } }
    expect(() => renderVendorWithLimits(limits)).toThrow()
    function renderVendorWithLimits(value: typeof DEFAULT_COMPILER_LIMITS) {
      return render(JSON.stringify(doc), value)
    }
  })
  it('exports the same offline renderer from the core SDK without opening an owner', async () => {
    const core = await import('../src/index.ts')
    expect(core.renderVendorImportPreview).toBe(render)
  })
  it('overrides full-width mobile panels only for the import report and following source disclosure', async () => {
    const html = render(await upload()).html
    expect(html).toContain('.import-review,.import-review~.lower{width:auto}')
    const plain = preview.renderPreview(await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8'))
    expect(plain.html).not.toContain('.import-review~.lower')
  })
})
