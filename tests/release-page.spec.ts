// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, webcrypto } from 'node:crypto'
import { releaseBrowser, renderReleasePage } from '../src/releases/page.ts'
import { releaseOpenApi } from '../src/releases/openapi.ts'
import { grantTokenProof } from '../src/access/grants.ts'

const token = 'b'.repeat(64), releaseSha256 = 'a'.repeat(64)
const runId = '11111111-1111-4111-8111-111111111111'
const attemptId = '22222222-2222-4222-8222-222222222222'
const result = (value: unknown, status = 200) => ({ ok: status < 400, status, json: async () => value })
const info = { release: { sha256: releaseSha256, version: '1.2.3' }, graph: { name: 'Support triage', order: ['start', 'decide', 'review', 'done'],
  nodes: [{ id: 'start', kind: 'trigger' }, { id: 'decide', kind: 'decision', title: '<img src=x onerror=alert(1)>' },
    { id: 'review', kind: 'humanApproval', title: 'Review draft', actions: ['approve', 'reject'] }, { id: 'done', kind: 'output' }],
  edges: [{ from: 'start', to: 'decide' }, { from: 'decide', to: 'review', port: 'uncertain' }, { from: 'review', to: 'done', port: 'approve' }] },
  requirements: { inputSchema: { type: 'string' } } }
const receipt = { id: runId, status: 'waiting', nodeId: 'review', attemptId, steps: [{ nodeId: 'start' }, { nodeId: 'decide' }] }

function mount(responder: (operation: string, body: any) => unknown = () => ({}), workflowInfo: any = info, reviewerEnabled = false) {
  const page = renderReleasePage(reviewerEnabled)
  // Exercise the exported function once; jsdom otherwise executes the inline copy
  // while document.write runs and registers a second set of handlers.
  document.open(); document.write(page.html.replace(/<script>[\s\S]*?<\/script>/u, '')); document.close()
  const calls: { path: string; body?: any }[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit) => {
    if (path === '/v1/capabilities') return result({ mode: 'release-execution', protocolVersion: 'jevable/v1alpha1', release: { sha256: releaseSha256 } })
    if (path === '/v1/openapi.json') return result(releaseOpenApi())
    const body = JSON.parse(String(options.body))
    calls.push({ path, body })
    if (body.operation === 'release.info') return result({ result: workflowInfo })
    const answer = await responder(body.operation, body)
    return result({ result: answer })
  }))
  releaseBrowser()
  return { page, calls, login: async () => {
    (document.getElementById('owner-token') as HTMLInputElement).value = token
    document.getElementById('login-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(document.getElementById('workspace')!.hidden).toBe(false))
  } }
}
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren() })

describe('standalone release browser page', () => {
  it('has a hash-bound offline shell and does no authenticated read or execution on opening', () => {
    const { page, calls } = mount()
    const style = page.html.match(/<style>([\s\S]*?)<\/style>/)![1]!
    const script = page.html.match(/<script>([\s\S]*?)<\/script>/)![1]!
    for (const source of [style, script]) expect(page.csp).toContain(`'sha256-${createHash('sha256').update(source).digest('base64')}'`)
    expect(calls).toEqual([])
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
    expect(document.getElementById('workspace-nav')!.hidden).toBe(true)
    expect(document.getElementById('signout')!.hidden).toBe(true)
    expect(page.html).not.toContain(token)
    expect(page.html).not.toContain(releaseSha256)
  })

  it('authenticates explicitly, renders untrusted labels as text, and starts one retained run only on submission', async () => {
    const { calls, login } = mount((operation) => operation === 'runs.start' ? receipt : {})
    await login()
    expect(calls.map(call => call.body.operation)).toEqual(['release.info'])
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('[data-node-id="decide"]')?.textContent).toContain('<img src=x')
    expect(document.querySelectorAll('.flow-column')).toHaveLength(4)
    expect(document.querySelector<HTMLElement>('.flow-viewport')!.tabIndex).toBe(0)
    expect(document.querySelector('.flow-hint')?.textContent).toContain('Swipe or scroll sideways')
    ;(document.getElementById('workflow-input') as HTMLTextAreaElement).value = 'sample ticket'
    document.getElementById('run-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(calls.filter(call => call.body.operation === 'runs.start')).toHaveLength(1))
    const started = calls.find(call => call.body.operation === 'runs.start')!.body
    expect(started).toMatchObject({ input: 'sample ticket', releaseSha256 })
    expect(started.id).toMatch(/^[0-9a-f-]{36}$/)
    await vi.waitFor(() => expect(document.getElementById('run-result')!.textContent).toContain('Run waiting'))
    expect(document.querySelector('[data-node-id="review"]')?.classList.contains('waiting')).toBe(true)
  })

  it('guides nested closed inputs, bounded lists, choices and optional fields without changing their JSON meaning', async () => {
    const nested = { ...info, requirements: { inputSchema: { type: 'object', additionalProperties: false,
      required: ['ticket', 'tags'], properties: {
        ticket: { type: 'object', additionalProperties: false, required: ['message', 'priority'], properties: {
          message: { type: 'string', minLength: 1, maxLength: 500 },
          priority: { type: 'string', enum: ['low', 'high'] },
          owner: { type: 'string' },
        } },
        tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
        active: { type: 'boolean' },
      } } } }
    const { calls, login } = mount(operation => operation === 'runs.start' ? receipt : {}, nested)
    await login()
    expect(document.getElementById('workflow-input')).toBeNull()
    expect(document.querySelectorAll('.array-item')).toHaveLength(1)
    const submit = () => document.getElementById('run-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    const message = document.querySelector<HTMLTextAreaElement>('#input-fields textarea')!
    message.value = 'Please review this ticket.'
    submit()
    expect(calls.some(call => call.body.operation === 'runs.start')).toBe(false)
    expect(document.getElementById('status')!.textContent).toContain('Choose priority')
    const priority = document.querySelector<HTMLSelectElement>('#input-fields select')!
    expect(document.activeElement).toBe(priority)
    priority.value = '1'
    const tags = () => [...document.querySelectorAll<HTMLTextAreaElement>('.array-item textarea')]
    tags()[0]!.value = 'billing'
    const add = [...document.querySelectorAll<HTMLButtonElement>('#input-fields button')].find(button => button.textContent === 'Add item')!
    add.click(); tags()[1]!.value = 'urgent'
    expect(add.disabled).toBe(true)
    expect([...document.querySelectorAll<HTMLElement>('.array-item')].map(item => item.getAttribute('aria-label'))).toEqual(['Item 1', 'Item 2'])
    const ownerToggle = [...document.querySelectorAll<HTMLLabelElement>('.include-field')].find(label => label.textContent?.includes('owner'))!
    ;(ownerToggle.querySelector('input') as HTMLInputElement).click()
    const owner = ownerToggle.nextElementSibling!.querySelector('textarea') as HTMLTextAreaElement
    owner.value = 'Support team'
    submit()
    await vi.waitFor(() => expect(calls.filter(call => call.body.operation === 'runs.start')).toHaveLength(1))
    expect(calls.find(call => call.body.operation === 'runs.start')!.body.input).toEqual({ ticket: {
      message: 'Please review this ticket.', priority: 'high', owner: 'Support team',
    }, tags: ['billing', 'urgent'] })
    ;([...document.querySelectorAll<HTMLButtonElement>('#input-fields button')].find(button => button.textContent === 'Edit as JSON')!).click()
    expect(JSON.parse((document.getElementById('workflow-input') as HTMLTextAreaElement).value)).toEqual(calls.find(call => call.body.operation === 'runs.start')!.body.input)
    document.getElementById('signout')!.click()
    expect(document.body.textContent).not.toContain('Support team')
  })

  it('preserves an incomplete guided form and gives open objects the full JSON path', async () => {
    const nested = { ...info, requirements: { inputSchema: { type: 'object', additionalProperties: false,
      required: ['choice'], properties: { choice: { type: 'string', enum: ['one', 'two'] } } } } }
    const guided = mount(undefined, nested)
    await guided.login()
    ;([...document.querySelectorAll<HTMLButtonElement>('#input-fields button')].find(button => button.textContent === 'Edit as JSON')!).click()
    expect(document.getElementById('workflow-input')).toBeNull()
    expect(document.getElementById('status')!.textContent).toContain('Choose choice')
    document.getElementById('signout')!.click()
    const open = { ...info, requirements: { inputSchema: { type: 'object', properties: { note: { type: 'string' } } } } }
    const fallback = mount(operation => operation === 'runs.start' ? receipt : {}, open)
    await fallback.login()
    const input = document.getElementById('workflow-input') as HTMLTextAreaElement
    expect(input.value).toBe('{}')
    input.value = '{"note":"hello","extra":true}'
    document.getElementById('run-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(fallback.calls.find(call => call.body.operation === 'runs.start')?.body.input).toEqual({ note: 'hello', extra: true }))
  })

  it('keeps nested array item controls in order when items are added and removed', async () => {
    const arrayInfo = { ...info, requirements: { inputSchema: { type: 'array', minItems: 1, maxItems: 2,
      items: { type: 'object', additionalProperties: false, required: ['score'], properties: {
        score: { type: 'integer', minimum: 0, maximum: 10 }, flag: { type: 'boolean' },
      } } } } }
    const { calls, login } = mount(operation => operation === 'runs.start' ? receipt : {}, arrayInfo)
    await login()
    const add = [...document.querySelectorAll<HTMLButtonElement>('#input-fields button')].find(button => button.textContent === 'Add item')!
    const remove = () => [...document.querySelectorAll<HTMLButtonElement>('.array-item button')].filter(button => button.textContent === 'Remove item')
    expect(remove()[0]!.disabled).toBe(true)
    add.click()
    expect(add.disabled).toBe(true)
    expect(remove().every(button => !button.disabled)).toBe(true)
    remove()[0]!.click()
    expect(document.querySelectorAll('.array-item')).toHaveLength(1)
    expect(document.querySelector('.array-item strong')?.textContent).toBe('Item 1')
    expect(document.querySelector('.array-item button')?.getAttribute('aria-label')).toBe('Remove item 1')
    expect(remove()[0]!.disabled).toBe(true)
    ;(document.querySelector('.array-item input[type=number]') as HTMLInputElement).value = '7'
    document.getElementById('run-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(calls.find(call => call.body.operation === 'runs.start')?.body.input).toEqual([{ score: 7 }]))
  })

  it('focuses invalid guided numeric fields and enforces schema bounds before dispatch', async () => {
    const numeric = { ...info, requirements: { inputSchema: { type: 'object', additionalProperties: false,
      required: ['score'], properties: { score: { type: 'integer', minimum: 0, maximum: 10 } } } } }
    const { calls, login } = mount(operation => operation === 'runs.start' ? receipt : {}, numeric)
    await login()
    const score = document.getElementById('input-score') as HTMLInputElement
    const submit = () => document.getElementById('run-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    score.value = '11'; submit()
    expect(document.activeElement).toBe(score)
    expect(document.getElementById('status')!.textContent).toContain('above the allowed maximum')
    expect(calls.some(call => call.body.operation === 'runs.start')).toBe(false)
    score.value = '7'; submit()
    await vi.waitFor(() => expect(calls.find(call => call.body.operation === 'runs.start')?.body.input).toEqual({ score: 7 }))
  })

  it('counts Unicode code points like the workflow schema and focuses invalid JSON', async () => {
    const short = { ...info, requirements: { inputSchema: { type: 'string', minLength: 2, maxLength: 2 } } }
    const first = mount(operation => operation === 'runs.start' ? receipt : {}, short)
    await first.login()
    const input = document.getElementById('workflow-input') as HTMLTextAreaElement
    input.value = '😀'
    document.getElementById('run-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(first.calls.some(call => call.body.operation === 'runs.start')).toBe(false)
    expect(document.activeElement).toBe(input)
    input.value = '😀x'
    document.getElementById('run-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(first.calls.find(call => call.body.operation === 'runs.start')?.body.input).toBe('😀x'))

    document.getElementById('signout')!.click()
    const one = { ...info, requirements: { inputSchema: { type: 'string', maxLength: 1 } } }
    const second = mount(operation => operation === 'runs.start' ? receipt : {}, one)
    await second.login()
    const oneInput = document.getElementById('workflow-input') as HTMLTextAreaElement
    expect(oneInput.maxLength).toBe(-1)
    oneInput.value = '😀'
    document.getElementById('run-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(second.calls.find(call => call.body.operation === 'runs.start')?.body.input).toBe('😀'))

    document.getElementById('signout')!.click()
    const open = { ...info, requirements: { inputSchema: { type: 'object', properties: { note: { type: 'string' } } } } }
    const third = mount(undefined, open)
    await third.login()
    const json = document.getElementById('workflow-input') as HTMLTextAreaElement
    json.value = '{broken'
    document.getElementById('run-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(third.calls.some(call => call.body.operation === 'runs.start')).toBe(false)
    expect(document.activeElement).toBe(json)
    expect(document.getElementById('status')!.textContent).toContain('Enter valid JSON')
  })

  it('offers only enum choices that the published schema can accept', async () => {
    const narrowed = { ...info, requirements: { inputSchema: { type: 'object', additionalProperties: false,
      required: ['answer'], properties: { answer: { type: 'string', minLength: 1, maxLength: 1,
        enum: ['too long', '😀', 7, 'x'] } } } } }
    const { calls, login } = mount(operation => operation === 'runs.start' ? receipt : {}, narrowed)
    await login()
    const select = document.getElementById('input-answer') as HTMLSelectElement
    expect([...select.options].map(option => option.textContent)).toEqual(['Choose an option', '😀', 'x'])
    select.value = '0'
    document.getElementById('run-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(calls.find(call => call.body.operation === 'runs.start')?.body.input).toEqual({ answer: '😀' }))
  })

  it('requires explicit review acknowledgement and clears private review data on sign-out', async () => {
    const { calls, login } = mount((operation) => operation === 'approvals.list'
      ? { tasks: [{ runId, nodeId: 'review', attemptId, expiresAt: '2030-01-01T00:00:00Z' }] }
      : operation === 'approvals.show'
        ? { ...receipt, review: { status: 'ready', input: { title: 'Approve draft?', input: { message: 'PRIVATE_REVIEW' } } } }
        : operation === 'approvals.decide' ? { ...receipt, status: 'completed', output: 'approved' } : {})
    await login()
    document.getElementById('nav-approvals')!.click()
    await vi.waitFor(() => expect(document.getElementById('approval-list')!.textContent).toContain('Request awaiting a decision'))
    expect(document.getElementById('approval-list')!.textContent).toContain(new Date('2030-01-01T00:00:00Z').toLocaleString())
    expect(document.getElementById('approval-list')!.textContent).not.toContain('2030-01-01T00:00:00Z')
    expect(calls.filter(call => call.body.operation === 'approvals.decide')).toHaveLength(0)
    ;(document.querySelector('#approval-list button') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(document.getElementById('approval-review')!.textContent).toContain('PRIVATE_REVIEW'))
    expect(document.querySelector('#approval-review dt')?.textContent).toBe('Message')
    expect(document.querySelector('#approval-review details')?.hasAttribute('open')).toBe(false)
    expect(document.activeElement).toBe(document.getElementById('approval-review'))
    const approve = [...document.querySelectorAll<HTMLButtonElement>('#approval-review button')].find(button => button.textContent === 'approve')!
    expect(approve.disabled).toBe(true)
    approve.click(); expect(calls.filter(call => call.body.operation === 'approvals.decide')).toHaveLength(0)
    const checkbox = document.getElementById('approval-confirm') as HTMLInputElement
    checkbox.checked = true; checkbox.dispatchEvent(new Event('change'))
    expect(approve.disabled).toBe(false)
    approve.click()
    await vi.waitFor(() => expect(calls.filter(call => call.body.operation === 'approvals.decide')).toHaveLength(1))
    await vi.waitFor(() => expect(document.getElementById('tab-run')!.hidden).toBe(false))
    expect(document.getElementById('run-result')!.textContent).toContain('Run completed')
    expect(calls.find(call => call.body.operation === 'approvals.decide')!.body).toMatchObject({ id: runId, attemptId, action: 'approve', releaseSha256 })
    document.getElementById('signout')!.click()
    expect(document.getElementById('approval-review')!.textContent).not.toContain('PRIVATE_REVIEW')
    expect(document.getElementById('workspace')!.hidden).toBe(true)
    expect(document.activeElement).toBe(document.getElementById('owner-token'))
  })

  it('lets an owner issue one scoped review token and retry the same issuance after a lost reply', async () => {
    vi.stubGlobal('crypto', webcrypto)
    let issueAttempts = 0
    const { calls, login } = mount((operation, body) => operation === 'approvals.list'
      ? { tasks: [{ runId, nodeId: 'review', attemptId, expiresAt: '2030-01-01T00:00:00Z' }] }
      : operation === 'approvals.show'
        ? { ...receipt, review: { status: 'ready', input: { title: 'Approve draft?', input: { message: 'PRIVATE_REVIEW' } } } }
        : operation === 'reviewers.issue' ? (++issueAttempts === 1 ? (() => { throw Error('Lost reply') })()
          : { id: body.id, scope: { runId, attemptId } }) : {}, info, true)
    await login()
    document.getElementById('nav-approvals')!.click()
    await vi.waitFor(() => expect(document.querySelector('#approval-list button')).not.toBeNull())
    ;(document.querySelector('#approval-list button') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(document.getElementById('approval-review')!.textContent).toContain('PRIVATE_REVIEW'))
    const create = [...document.querySelectorAll<HTMLButtonElement>('#approval-review button')]
      .find(button => button.textContent === 'Create review token')!
    create.click()
    const retry = [...document.querySelectorAll<HTMLButtonElement>('#approval-review button')]
      .find(button => button.textContent === 'Check same token request')!
    await vi.waitFor(() => expect(retry.hidden).toBe(false))
    retry.click()
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('input[aria-label="One-time review token"]')).not.toBeNull())
    const issued = calls.filter(call => call.body.operation === 'reviewers.issue')
    expect(issued).toHaveLength(2)
    expect(issued[0]!.body).toEqual(issued[1]!.body)
    expect(issued[0]!.body).toMatchObject({ runId, attemptId, decisions: ['approve', 'reject'], releaseSha256 })
    const secret = document.querySelector<HTMLInputElement>('input[aria-label="One-time review token"]')!.value
    expect(grantTokenProof(secret)).toEqual({ id: issued[0]!.body.id, tokenSha256: issued[0]!.body.tokenSha256 })
    expect(calls.some(call => JSON.stringify(call.body).includes(secret))).toBe(false)
    expect(document.querySelector<HTMLAnchorElement>('#approval-review a')?.getAttribute('href')).toBe('/review')
    document.getElementById('signout')!.click()
    expect(document.body.textContent).not.toContain(secret)
  })

  it('renders structured result fields as readable text while keeping exact JSON optional and untrusted keys inert', async () => {
    const finished = { ...receipt, status: 'completed', output: {
      customerName: 'Avery', approved: false, tags: ['one', 'two'], '<img src=x onerror=alert(1)>': 'safe',
    } }
    const { login } = mount(operation => operation === 'runs.start' ? finished : {})
    await login()
    ;(document.getElementById('workflow-input') as HTMLTextAreaElement).value = 'sample'
    document.getElementById('run-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(document.getElementById('run-result')!.textContent).toContain('Customer Name'))
    const result = document.getElementById('run-result')!
    expect(result.textContent).toContain('Avery')
    expect(result.textContent).toContain('No')
    expect(result.querySelectorAll('.value-list li')).toHaveLength(2)
    expect(result.querySelector('img')).toBeNull()
    expect(result.querySelector('details')?.hasAttribute('open')).toBe(false)
    expect(result.querySelector('details pre')?.textContent).toContain('"approved": false')
  })

  it('shows saved step and trace metadata, but only reads private values after an explicit click', async () => {
    const traced = { ...receipt, createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:01.000Z',
      traceSegments: [{ operation: 'run', trace: { traceId: '1'.repeat(32), spanId: '2'.repeat(16) } }],
      steps: [{ nodeId: 'start', startedAt: '2026-10-18T00:00:00.000Z', durationMs: 18, attemptId,
        trace: { traceId: '1'.repeat(32), spanId: '2'.repeat(16) } },
        { nodeId: 'decide', port: 'uncertain', durationMs: 33 }] }
    const { calls, login } = mount(operation => operation === 'runs.start' ? traced : operation === 'runs.inspect'
      ? { schemaVersion: 1, privateInspection: true, run: { input: 'PRIVATE_INPUT', caller: { grantId: 'PRIVATE_GRANT' }, state: { steps: [
        { nodeId: 'start', output: 'PRIVATE_STEP' }, { nodeId: 'decide', output: { choice: 'uncertain' },
          inspection: { approval: { kind: 'action', action: 'approve', actor: 'PRIVATE_REVIEWER', at: '2026-10-18T00:00:01.000Z' } } }] } } } : {})
    await login()
    ;(document.getElementById('workflow-input') as HTMLTextAreaElement).value = 'PRIVATE_FORM_VALUE'
    document.getElementById('run-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(document.getElementById('run-result')!.textContent).toContain('2 recorded steps'))
    expect(document.getElementById('run-result')!.textContent).toContain('Branch: uncertain')
    expect(document.getElementById('run-result')!.textContent).toContain('Trace ' + '1'.repeat(32))
    expect(document.getElementById('run-result')!.textContent).toContain(`Attempt ${attemptId}`)
    expect(document.getElementById('run-result')!.textContent).toContain('Published version 1.2.3')
    expect(document.getElementById('run-result')!.textContent).toContain('Started ')
    expect(calls.some(call => call.body.operation === 'runs.inspect')).toBe(false)
    expect(document.getElementById('run-result')!.textContent).not.toContain('PRIVATE_STEP')
    expect(document.getElementById('run-result')!.textContent).not.toContain('PRIVATE_GRANT')
    expect(document.getElementById('run-result')!.textContent).not.toContain('PRIVATE_REVIEWER')
    ;(document.getElementById('inspect-run') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(document.getElementById('run-result')!.textContent).toContain('PRIVATE_STEP'))
    expect(document.getElementById('run-result')!.textContent).toContain('PRIVATE_GRANT')
    expect(document.getElementById('run-result')!.textContent).toContain('Approval: approve · by PRIVATE_REVIEWER')
    expect(calls.filter(call => call.body.operation === 'runs.inspect')).toHaveLength(1)
    document.getElementById('signout')!.click()
    expect(document.body.textContent).not.toContain('PRIVATE_STEP')
    expect(document.body.textContent).not.toContain('PRIVATE_INPUT')
    expect(document.body.textContent).not.toContain('PRIVATE_GRANT')
    expect(document.body.textContent).not.toContain('PRIVATE_REVIEWER')
    expect(document.getElementById('workflow-input')).toBeNull()
    expect(document.title).toBe('Published workflow · Jevable')
  })

  it('labels each graph step and reads audit metadata only after an explicit request', async () => {
    const events = { runId, privatePayloads: 'excluded', events: [
      { sequence: 1, kind: 'run-started', at: '2026-10-18T00:00:00.000Z' },
      { sequence: 2, kind: 'approval-requested', at: '2026-10-18T00:00:01.000Z' },
    ] }
    const { calls, login } = mount(operation => operation === 'runs.start' ? receipt : operation === 'runs.events' ? events : {})
    await login()
    expect(document.querySelector('[data-node-id="done"] .node-status')?.textContent).toBe('Not run yet')
    document.getElementById('run-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(document.getElementById('run-result')!.textContent).toContain('Run waiting'))
    expect(document.querySelector('[data-node-id="start"] .node-status')?.textContent).toBe('Completed')
    expect(document.querySelector('[data-node-id="review"] .node-status')?.textContent).toBe('Waiting for approval')
    expect(document.querySelector('[data-node-id="done"] .node-status')?.textContent).toBe('Not reached')
    expect(calls.some(call => call.body.operation === 'runs.events')).toBe(false)
    document.getElementById('events-run')!.click()
    await vi.waitFor(() => expect(document.querySelector('.audit-events')?.textContent).toContain('approval-requested'))
    expect(document.querySelector('.audit-events')?.textContent).toContain('private inputs and outputs are excluded')
    expect(calls.filter(call => call.body.operation === 'runs.events')).toHaveLength(1)
    expect(calls.filter(call => call.body.operation === 'runs.start')).toHaveLength(1)
    document.getElementById('signout')!.click()
    expect(document.body.textContent).not.toContain('approval-requested')
  })

  it('offers simple pagination for saved runs and sparse approval pages', async () => {
    const older = '33333333-3333-4333-8333-333333333333'
    const { calls, login } = mount((operation, body) => operation === 'runs.list'
      ? body.page.after ? { runs: [{ id: older, status: 'completed' }], nextCursor: null }
        : { runs: [{ id: runId, status: 'waiting' }], nextCursor: runId }
      : operation === 'approvals.list'
        ? body.page.after ? { tasks: [{ runId: older, nodeId: 'review', attemptId, expiresAt: '2030-01-01T00:00:00Z' }], nextCursor: null }
          : { tasks: [], nextCursor: runId } : {})
    await login()
    document.getElementById('nav-log')!.click()
    await vi.waitFor(() => expect(document.getElementById('run-more')!.hidden).toBe(false))
    document.getElementById('run-more')!.click()
    await vi.waitFor(() => expect(document.getElementById('run-list')!.textContent).toContain(older))
    expect(document.getElementById('run-more')!.hidden).toBe(true)
    expect(calls.find(call => call.body.operation === 'runs.list' && call.body.page.after)?.body.page.after).toBe(runId)
    document.getElementById('nav-approvals')!.click()
    await vi.waitFor(() => expect(document.getElementById('approval-more')!.hidden).toBe(false))
    expect(document.getElementById('approval-list')!.textContent).toContain('Continue to the next page')
    document.getElementById('approval-more')!.click()
    await vi.waitFor(() => expect(document.getElementById('approval-list')!.textContent).toContain(older))
    expect(document.getElementById('approval-more')!.hidden).toBe(true)
  })

  it('does not repopulate private values when an in-flight inspection finishes after sign-out', async () => {
    let settle!: (value: unknown) => void
    const inspection = new Promise<unknown>(resolve => { settle = resolve })
    const { login } = mount(operation => operation === 'runs.start' ? receipt : operation === 'runs.inspect' ? inspection : {})
    await login()
    document.getElementById('run-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(document.getElementById('inspect-run')).not.toBeNull())
    document.getElementById('inspect-run')!.click()
    document.getElementById('signout')!.click()
    settle({ run: { input: 'LATE_PRIVATE_INPUT', state: { steps: [{ nodeId: 'start', output: 'LATE_PRIVATE_STEP' }] } } })
    await vi.waitFor(() => expect(document.getElementById('status')!.textContent).toContain('session changed'))
    expect(document.body.textContent).not.toContain('LATE_PRIVATE_INPUT')
    expect(document.body.textContent).not.toContain('LATE_PRIVATE_STEP')
  })

  it('loads the real OpenAPI guide only after the owner opens it, without putting the token in a URL', async () => {
    const { login } = mount()
    await login()
    expect(releaseOpenApi().paths['/v1/operations']).toBeDefined()
    expect(vi.mocked(fetch).mock.calls.some(call => call[0] === '/v1/openapi.json')).toBe(false)
    document.getElementById('nav-guide')!.click()
    document.getElementById('api-reference-button')!.click()
    await vi.waitFor(() => expect(document.getElementById('api-reference')!.textContent).toContain('POST /v1/operations'))
    const call = vi.mocked(fetch).mock.calls.find(item => item[0] === '/v1/openapi.json')!
    expect((call[1] as RequestInit).headers).toMatchObject({ authorization: `Bearer ${token}` })
    expect(document.getElementById('api-reference')!.textContent).toContain('Start a retained run')
    document.getElementById('signout')!.click()
    expect(document.getElementById('api-reference')!.textContent).toBe('')
  })

})
