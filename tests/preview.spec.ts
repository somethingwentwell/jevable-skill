import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPreview, renderPreview } from '../src/preview/index.ts'
import { workspaceCss } from '../src/preview/workspace-style.ts'
import { parseWorkflow } from '../src/workflow/index.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { listTemplates, renderTemplate } from '../src/templates/index.ts'
import { main } from '../src/cli.ts'
import { JSDOM } from 'jsdom'

const source = () => readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
describe('portable workflow inspection', () => {
  it('keeps the full run receipt behind a closed disclosure and announces only the short status', async () => {
    const { html } = renderPreview(await source()), dom = new JSDOM(html)
    try {
      const document = dom.window.document, overlay = document.getElementById('execution-overlay')!
      const disclosure = overlay.querySelector('details')!
      expect(overlay.hasAttribute('hidden')).toBe(true)
      expect(disclosure.hasAttribute('open')).toBe(false)
      expect(disclosure.querySelector('#execution-summary')).not.toBeNull()
      expect(disclosure.querySelector('#execution-status')).toBeNull()
      expect(overlay.querySelector('#execution-status')!.getAttribute('aria-live')).toBe('polite')
      expect(overlay.querySelector('#execution-status')!.getAttribute('aria-atomic')).toBe('true')
      expect(disclosure.querySelector('#execution-summary')!.hasAttribute('aria-live')).toBe(false)
      expect(overlay.querySelector('#execution-status')!.textContent).toBe('')
      // The live workspace hides legacy top-level muted paragraphs. The short
      // evidence caveat must remain visible there as well as in portable HTML.
      const style = document.createElement('style'); style.textContent = workspaceCss; document.head.append(style)
      expect(dom.window.getComputedStyle(overlay.querySelector('#execution-guidance')!).display).not.toBe('none')
    } finally { dom.window.close() }
  })

  it('pins canonical revision separately from exact source bytes and never claims execution', async () => {
    const yaml = await source(), preview = createPreview(yaml)
    expect(preview.revision).toBe(parseWorkflow(yaml, DEFAULT_COMPILER_LIMITS.source).revision)
    expect(preview.sourceSha256).toBe(createHash('sha256').update(yaml).digest('hex'))
    expect(preview.execution).toBe('not-run')
    expect(preview.runtimeReadiness).toBe('not-checked')
    expect(preview.graphs[0]!.nodes.map(item => item.id).sort()).toEqual(['result', 'review', 'start'])
    expect(preview.graphs[0]!.edges).toContainEqual({ from: 'review', port: 'approve', to: 'result' })
    expect(preview.graphs[0]!.nodes).not.toContainEqual(expect.objectContaining({ id: 'rejected' }))
  })

  it('retains malformed graph connections without inventing admitted revision or missing nodes', async () => {
    const yaml = (await source()).replace('to: review', 'to: missing')
    const preview = createPreview(yaml)
    expect(preview.validation.status).toBe('invalid')
    expect(preview.revision).toBeNull()
    expect(preview.graphs[0]!.edges).toContainEqual({ from: 'start', to: 'missing' })
    expect(preview.graphs[0]!.nodes.some(item => item.id === 'missing')).toBe(false)
    expect(preview.graphs[0]!.diagnostics[0]).toContain('missing nodes')
  })

  it('shows a source-admitted but non-compiling draft truthfully', async () => {
    const yaml = (await source()).replace('nodes.review.output.action', 'nodes.missing.output')
    const preview = createPreview(yaml)
    expect(preview.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(preview.validation.status).toBe('invalid')
    expect(preview.validation.diagnostics.length).toBeGreaterThan(0)
  })

  it.each(listTemplates().map(item => item.id))('represents template %s and its scoped loop exits', id => {
    const yaml = JSON.stringify(renderTemplate(id, { model: { provider: 'llm', model: 'fixture/model' } }))
    const preview = createPreview(yaml)
    expect(preview.name).toBeTruthy()
    expect(preview.graphs[0]!.scope).toBe('workflow')
    for (const node of preview.graphs[0]!.nodes.filter(item => item.node.type === 'loop')) {
      const body = preview.graphs.find(graph => graph.scope === node.bodyScope)!
      expect(body).toBeDefined()
      expect(body.nodes.some(item => item.id === body.entry)).toBe(true)
      expect(body.exits.length).toBeGreaterThan(0)
    }
  })

  it('escapes hostile labels and source while preserving the exact JSON data', async () => {
    const payload = '</script><img src=x onerror="globalThis.pwned=1">&\u2028'
    const doc = JSON.parse(JSON.stringify(parseWorkflow(await source(), DEFAULT_COMPILER_LIMITS.source).document))
    doc.metadata.name = payload
    doc.spec.nodes.review.title = payload
    doc.spec.nodes.review.description = payload
    const { data, html } = renderPreview(JSON.stringify(doc))
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain(payload)
    const serialized = html.match(/<script id="preview-data" type="application\/json">([\s\S]*?)<\/script>/)![1]!
    expect(JSON.parse(serialized)).toEqual(data)
    expect(html.match(/<script(?: |>)/g)).toHaveLength(2)
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!
    expect(html).toContain(`sha256-${createHash('sha256').update(script).digest('base64')}`)
    expect(html).toContain("connect-src &#39;none&#39;")
    expect(script).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|eval)\s*\(/)
    expect(script).not.toContain('innerHTML')
  })

  it('rejects alias documents and configured source limits', async () => {
    expect(() => createPreview('a: &source [1]\nb: *source')).toThrow()
    const limits = { ...DEFAULT_COMPILER_LIMITS, source: { ...DEFAULT_COMPILER_LIMITS.source, maxSourceBytes: 10 } }
    expect(() => createPreview('source longer than ten bytes', limits)).toThrow(/byte budget/)
    const doc = JSON.parse(JSON.stringify(parseWorkflow(await source(), DEFAULT_COMPILER_LIMITS.source).document))
    doc.spec.nodes.extra = { type: 'not-a-node', config: {} }
    expect(() => createPreview(JSON.stringify(doc))).toThrow(/known node families/)
  })

  it.each(['telemetry-file', 'token-file', 'port', 'data-dir', 'runtime', 'owner-file', 'owner-sha256', 'container-id', 'ca-file', 'timeout-ms', 'preview-token-file', 'project-id'])('refuses --%s in offline preview mode without reading runtime configuration', async (option) => {
    const out = vi.fn(), err = vi.fn()
    expect(await main(['preview', new URL('../examples/approval.yaml', import.meta.url).pathname,
      '--output', '/unused-preview-output.html', `--${option}`, option === 'runtime' ? 'local' : ['port', 'timeout-ms'].includes(option) ? '1'
        : ['owner-sha256', 'container-id'].includes(option) ? 'a'.repeat(64) : option === 'project-id' ? 'ea953a2f-2d9c-42ad-9910-9c4fb2708d21' : 'unused'], { out, err })).toBe(2)
    expect(err.mock.calls.flat().join('')).toContain('Runtime options require --serve')
    expect(out).not.toHaveBeenCalled()
  })

  it('writes a standalone HTML artifact through the CLI and refuses implicit overwrite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-preview-')), output = join(directory, 'workflow.html')
    const out = vi.fn(), err = vi.fn()
    const command = ['preview', new URL('../examples/approval.yaml', import.meta.url).pathname, '--output', output, '--json']
    expect(await main(command, { out, err })).toBe(0)
    const receipt = JSON.parse(out.mock.calls[0]![0])
    expect(receipt).toMatchObject({ execution: 'not-run', visualReview: 'not-performed', format: 'jevable.preview/v1' })
    expect((await readFile(output, 'utf8')).startsWith('<!doctype html>')).toBe(true)
    expect(await main(command, { out, err })).toBe(1)
    expect(await main([...command, '--overwrite'], { out, err })).toBe(0)
  })
})
