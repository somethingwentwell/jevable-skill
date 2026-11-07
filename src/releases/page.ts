/// <reference lib="dom" />
import { createHash } from 'node:crypto'

export const releaseMark = '<svg viewBox="0 0 40 40" width="32" height="32" aria-hidden="true" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3.9" y="3.9" width="32.2" height="32.2" rx="7.3" fill="#111827"/><g stroke="#fff" stroke-width="3" stroke-linecap="round" transform="translate(3.9 3.9) scale(.805)"><circle cx="26" cy="10.5" r="3"/><path d="M26 13.5V23a7 7 0 0 1-7 7h-3"/><circle cx="13" cy="30" r="3"/></g></svg>'
const mark = releaseMark

const css = `[hidden]{display:none!important}:root{color-scheme:light dark;--bg:#f5f7f8;--surface:#fff;--ink:#1e2630;--muted:#53616e;--line:#dce3e8;--blue:#295fc6;--blue-soft:#eaf0fc;--green:#267354;--amber:#8b6024;--red:#ac3e43;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
@media(prefers-color-scheme:dark){:root{--bg:#151a20;--surface:#202730;--ink:#eff4f8;--muted:#bac7d1;--line:#3b4853;--blue:#9bbcff;--blue-soft:#273851;--green:#87cda9;--amber:#e7bb78;--red:#f2a0a4}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink)}button,input,textarea{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.55}a{color:var(--blue)}:focus-visible{outline:3px solid var(--blue);outline-offset:3px}h1,h2,h3,p{margin-top:0}h1{font-size:clamp(1.6rem,3vw,2.25rem);line-height:1.18;letter-spacing:-.035em}h2{font-size:1.12rem}h3{font-size:.95rem}p{color:var(--muted)}.skip{position:absolute;left:12px;top:-60px;background:var(--surface);padding:8px}.skip:focus{top:8px}.top{display:flex;align-items:center;gap:18px;min-height:70px;padding:12px clamp(16px,3vw,40px);background:var(--surface);border-bottom:1px solid var(--line)}.brand{display:flex;align-items:center;gap:9px;font-weight:750;letter-spacing:-.04em;font-size:1.25rem}.brand svg{flex:none}.top small{color:var(--muted);font-size:.78rem}.top nav{display:flex;gap:3px;flex-wrap:wrap;margin-left:auto}.top nav button{border:0;background:transparent;color:var(--muted);padding:8px 12px;border-radius:8px}.top nav button[aria-current=page]{background:var(--blue-soft);color:var(--blue);font-weight:650}.top .signout{border:1px solid var(--line);background:var(--surface);color:var(--ink);padding:7px 11px;border-radius:8px}.shell{max-width:1480px;margin:auto;padding:clamp(18px,3vw,42px)}.intro{max-width:760px;margin-bottom:24px}.intro p{margin-bottom:0}.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:22px}.login{max-width:480px;margin:8vh auto 0}.login p{line-height:1.65}.field{display:grid;gap:7px;margin:16px 0}.field label{font-weight:650;font-size:.9rem}.field small{color:var(--muted)}input,textarea{width:100%;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);padding:10px 12px}textarea{min-height:118px;resize:vertical}.button{min-height:40px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);padding:8px 14px;white-space:nowrap}.button.primary{background:#295fc6;border-color:#295fc6;color:#fff}.button:hover:not(:disabled){filter:brightness(.95)}.button:active:not(:disabled){transform:translateY(1px)}.actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:16px}.status{min-height:24px;margin:14px 0;color:var(--muted)}.status[data-tone=error]{color:var(--red)}.status[data-tone=success]{color:var(--green)}.split{display:grid;grid-template-columns:minmax(290px,370px) minmax(0,1fr);gap:20px;align-items:start}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.panel-head h2{margin:0}.flow-viewport{overflow:auto;min-height:280px;padding:22px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}.flow-canvas{position:relative;display:inline-block;min-width:100%}.flow-columns{position:relative;z-index:1;display:flex;gap:108px;width:max-content;min-height:210px}.flow-column{display:flex;flex-direction:column;gap:36px;min-width:190px;max-width:210px}.node{background:var(--surface);border:1px solid var(--line);border-radius:11px;padding:14px;min-height:90px;box-shadow:0 3px 12px #1224350b}.node strong{display:block;overflow-wrap:anywhere}.node small{display:block;color:var(--muted);margin-bottom:5px}.node p{font-size:.8rem;margin:7px 0 0;overflow-wrap:anywhere}.node.done{border-color:var(--green)}.node.waiting{border-color:var(--amber);border-style:dashed}.node.failed{border-color:var(--red)}.flow-lines{position:absolute;inset:0;z-index:0;overflow:visible;pointer-events:none}.flow-lines path{stroke:#9baab8;stroke-width:1.5;fill:none}.flow-lines text{fill:var(--muted);font-size:11px;paint-order:stroke;stroke:var(--surface);stroke-width:5px}.note{border-left:3px solid var(--blue);padding:9px 12px;background:var(--blue-soft);font-size:.87rem;color:var(--ink);margin:16px 0}.list{list-style:none;padding:0;margin:0;display:grid;gap:9px}.list li{border:1px solid var(--line);border-radius:10px;padding:12px;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}.list strong{overflow-wrap:anywhere}.list small{display:block;color:var(--muted)}.empty{padding:22px;border:1px dashed var(--line);border-radius:10px;color:var(--muted)}.readout{border:1px solid var(--line);border-radius:10px;padding:16px;background:var(--surface);margin-top:16px}.readout pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto;font-size:.8rem}.check{display:flex;align-items:flex-start;gap:10px;margin:15px 0}.check input{width:auto;margin-top:5px}.guide{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:16px}.guide .card{min-height:170px}.guide code{font-size:.83rem;overflow-wrap:anywhere}.footer{max-width:1480px;margin:auto;padding:12px clamp(18px,3vw,42px) 32px;color:var(--muted);font-size:.8rem}@media(max-width:820px){.top{flex-wrap:wrap}.top nav{order:3;width:100%;margin-left:0}.split{grid-template-columns:1fr}.flow-column{min-width:170px;max-width:190px}.flow-columns{gap:78px}}@media(max-width:480px){.shell{padding:18px}.card{padding:17px}.top{gap:10px}.top nav button{padding:8px}.flow-viewport{padding:14px}.flow-columns{gap:64px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}`

const historyCss = `.split>.card{min-width:0}.flow-viewport{max-width:100%}.flow-hint{font-size:.8rem;margin:8px 0 0}.node .node-status{color:var(--ink);font-weight:650}.step-history{padding-left:22px}.step-history li{margin:9px 0;padding-left:3px}.step-history small,.step-history code{display:block;color:var(--muted);font-size:.79rem;overflow-wrap:anywhere}.trace-list,.audit-events{border-top:1px solid var(--line);margin:18px 0;padding-top:14px}.trace-list p{font: .78rem/1.45 ui-monospace,SFMono-Regular,monospace;overflow-wrap:anywhere;margin:6px 0}.audit-events ol{padding-left:22px}.audit-events li{margin:8px 0;overflow-wrap:anywhere}.audit-events small{display:block;color:var(--muted)}.private-values{border-top:1px solid var(--line);margin-top:18px;padding-top:16px}.value-fields{margin:0;display:grid;gap:9px}.value-fields>div{border-bottom:1px solid var(--line);padding:6px 0}.value-fields dt{font-weight:650;overflow-wrap:anywhere}.value-fields dd{margin:3px 0 0;overflow-wrap:anywhere}.value-list{padding-left:22px;margin:0}.value-list li{margin:6px 0;overflow-wrap:anywhere}.value-view>details{margin-top:10px;color:var(--muted)}.input-group{min-width:0;border:1px solid var(--line);border-radius:10px;margin:14px 0;padding:14px}.input-group legend{font-weight:650;padding:0 5px}.input-group>small,.field>small{display:block;color:var(--muted)}.array-items{display:grid;gap:12px}.array-item{border:1px dashed var(--line);border-radius:9px;padding:12px;min-width:0}.include-field{display:flex;align-items:center;gap:9px;margin:14px 0;font-weight:600}.include-field input{width:auto;min-height:20px}.array-controls{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.array-controls button,.button{min-height:44px}.top nav button,.top .signout{min-height:44px}select{width:100%;min-height:44px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);padding:9px 11px}`

/** Browser code is serialized into the immutable release bundle. It uses only
 * same-origin, bearer-authenticated exact-release operations; opening is inert.
 */
export function releaseBrowser() {
  const $ = (id: string) => document.getElementById(id) as HTMLElement
  const make = (tag: string, className?: string, value?: string) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (value !== undefined) node.textContent = value
    return node
  }
  let token = ''
  let protocol = ''
  let pin = ''
  let info: any = null
  let selectedRun: any = null
  let pendingRun: { operation: 'runs.start'; id: string; input: unknown } | null = null
  let busy = false
  let activeTab = 'run'
  let sessionEpoch = 0
  let formReader: (() => unknown) | null = null
  let runCursor: string | null = null
  let approvalCursor: string | null = null
  let runPageSeq = 0
  let approvalPageSeq = 0
  let runViewSeq = 0
  const reviewerEnabled = document.body.dataset.reviewerDecisions === 'true'
  for (const [id, section, caption] of [['run-more', 'tab-log', 'Load more runs'],
    ['approval-more', 'tab-approvals', 'Check more requests']] as const) {
    const button = make('button', 'button', caption) as HTMLButtonElement
    button.id = id; button.type = 'button'; button.hidden = true
    $(section).querySelector('.card')!.append(button)
  }
  const apiButton = make('button', 'button', 'Show API reference') as HTMLButtonElement
  apiButton.id = 'api-reference-button'; apiButton.type = 'button'
  const apiPanel = make('div', 'readout'); apiPanel.id = 'api-reference'; apiPanel.hidden = true
  $('tab-guide').append(apiButton, apiPanel)
  const viewport = document.querySelector<HTMLElement>('.flow-viewport')!
  viewport.tabIndex = 0
  viewport.after(make('p', 'flow-hint', 'Swipe or scroll sideways to see every step. Keyboard: focus the diagram and use arrow keys.'))
  $('workspace-nav').hidden = true
  $('signout').hidden = true
  const status = (message: string, tone = '') => { $('status').textContent = message; $('status').dataset.tone = tone }
  const errorText = (error: unknown) => error instanceof Error ? error.message : 'The request did not finish. Check the saved result before trying again.'
  async function call(path: string, method: 'GET' | 'POST', command?: unknown): Promise<any> {
    const epoch = sessionEpoch
    const response = await fetch(path, { method, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'content-type': 'application/json', 'x-jevable-protocol': protocol } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify({ ...command as object, releaseSha256: pin }) } : {}) })
    const body = await response.json().catch(() => null)
    if (epoch !== sessionEpoch) throw new Error('The session changed. Connect again to see this result.')
    if (!response.ok || !body) throw new Error(body?.code ? `Request refused (${body.code}).` : `Request failed (${response.status}).`)
    return method === 'POST' ? body.result : body
  }
  const label = (node: any) => node?.title || node?.id || node?.nodeId || 'Step'
  const allNodes = () => new Map<string, any>((info?.graph?.nodes ?? []).map((node: any) => [node.id, node]))
  const fieldName = (key: string) => key.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replace(/[_-]+/gu, ' ')
    .replace(/^./u, first => first.toUpperCase())
  function valueView(value: unknown): HTMLElement {
    const wrapper = make('div', 'value-view'), budget = { remaining: 100 }
    const readable = (current: unknown, depth: number): HTMLElement => {
      if (current === null) return make('span', undefined, 'No value')
      if (typeof current === 'boolean') return make('span', undefined, current ? 'Yes' : 'No')
      if (typeof current === 'string') return make('span', undefined, current || '(empty text)')
      if (typeof current === 'number') return make('span', undefined, String(current))
      if (depth >= 4 || budget.remaining <= 0) return make('span', undefined, 'More details in the exact JSON below')
      if (Array.isArray(current)) {
        if (!current.length) return make('span', undefined, 'No items')
        const list = make('ol', 'value-list')
        for (const item of current.slice(0, 25)) { budget.remaining--; const row = make('li'); row.append(readable(item, depth + 1)); list.append(row) }
        if (current.length > 25) list.append(make('li', undefined, `More items in the exact JSON below (${current.length} total)`))
        return list
      }
      if (current && typeof current === 'object') {
        const entries = Object.entries(current)
        if (!entries.length) return make('span', undefined, 'No fields')
        const list = make('dl', 'value-fields')
        for (const [key, child] of entries.slice(0, 25)) {
          budget.remaining--; const row = make('div')
          row.append(make('dt', undefined, fieldName(key)))
          const answer = make('dd'); answer.append(readable(child, depth + 1)); row.append(answer); list.append(row)
        }
        if (entries.length > 25) list.append(make('div', undefined, `More fields in the exact JSON below (${entries.length} total)`))
        return list
      }
      return make('span', undefined, 'Value unavailable')
    }
    wrapper.append(readable(value, 0))
    if (value !== null && typeof value === 'object') {
      const exact = document.createElement('details')
      exact.append(make('summary', undefined, 'Show exact JSON'), make('pre', undefined, JSON.stringify(value, null, 2)))
      wrapper.append(exact)
    }
    return wrapper
  }
  function graph(run?: any) {
    const canvas = $('flow-canvas'), columns = $('flow-columns'), svg = $('flow-lines') as unknown as SVGSVGElement
    columns.replaceChildren(); svg.replaceChildren()
    const nodes = allNodes(), order: string[] = info?.graph?.order ?? [], edges: any[] = info?.graph?.edges ?? []
    const depths = new Map<string, number>()
    for (const id of order) {
      const incoming = edges.filter(edge => edge.to === id)
      depths.set(id, incoming.length ? 1 + Math.max(...incoming.map(edge => depths.get(edge.from) ?? 0)) : 0)
    }
    const byDepth = new Map<number, HTMLElement>()
    for (const id of order) {
      const depth = depths.get(id) ?? 0
      let column = byDepth.get(depth)
      if (!column) { column = make('div', 'flow-column'); byDepth.set(depth, column) }
      const node = nodes.get(id) ?? { id, kind: 'step' }
      const card = make('article', 'node')
      card.dataset.nodeId = id
      card.append(make('small', undefined, node.kind === 'decision' ? 'Decision · Jev' : node.kind === 'humanApproval' ? 'Human approval' : node.kind), make('strong', undefined, label(node)))
      if (node.description) card.append(make('p', undefined, node.description))
      const reached = run?.steps?.some((step: any) => step.nodeId === id)
      const current = run?.nodeId === id
      const nodeStatus = current ? ({ waiting: 'Waiting for approval', failed: 'Failed here', executing: 'Running or uncertain',
        paused: 'Paused here', cancelled: 'Cancelled here' } as Record<string, string>)[run.status] ?? 'Current step'
        : reached ? 'Completed' : run ? 'Not reached' : 'Not run yet'
      card.append(make('small', 'node-status', nodeStatus))
      if (reached) card.classList.add('done')
      if (current) card.classList.add(run.status === 'waiting' || run.status === 'paused' ? 'waiting' : run.status === 'failed' ? 'failed' : 'waiting')
      column.append(card)
    }
    for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) columns.append(byDepth.get(depth)!)
    const draw = () => {
      svg.replaceChildren()
      const box = canvas.getBoundingClientRect()
      svg.setAttribute('width', String(Math.max(canvas.scrollWidth, box.width)))
      svg.setAttribute('height', String(Math.max(canvas.scrollHeight, box.height)))
      for (const edge of edges) {
        const from = [...columns.querySelectorAll<HTMLElement>('[data-node-id]')].find(card => card.dataset.nodeId === edge.from)
        const to = [...columns.querySelectorAll<HTMLElement>('[data-node-id]')].find(card => card.dataset.nodeId === edge.to)
        if (!from || !to) continue
        const a = from.getBoundingClientRect(), b = to.getBoundingClientRect()
        const x1 = a.right - box.left, y1 = a.top + a.height / 2 - box.top
        const x2 = b.left - box.left, y2 = b.top + b.height / 2 - box.top
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        path.setAttribute('d', `M ${x1} ${y1} C ${x1 + 38} ${y1}, ${x2 - 38} ${y2}, ${x2} ${y2}`)
        svg.append(path)
        if (edge.port) {
          const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
          text.setAttribute('x', String(x1 + 16)); text.setAttribute('y', String(y1 - 7)); text.textContent = edge.port
          svg.append(text)
        }
      }
    }
    requestAnimationFrame(draw)
  }
  const omitted = Symbol('optional field not included')
  const enumChoices = (definition: any): unknown[] => (definition.enum ?? []).filter((value: unknown) => {
    if (definition.type === 'string') { const length = typeof value === 'string' ? Array.from(value).length : -1
      return length >= (definition.minLength ?? 0) && length <= (definition.maxLength ?? Infinity) }
    if (definition.type === 'number' || definition.type === 'integer') return typeof value === 'number' && Number.isFinite(value)
      && (definition.type !== 'integer' || Number.isInteger(value))
      && value >= (definition.minimum ?? -Infinity) && value <= (definition.maximum ?? Infinity)
    return definition.type === 'boolean' ? typeof value === 'boolean' : definition.type === 'null' && value === null
  })
  function renderableInput(definition: any, depth = 0, budget = { fields: 0 }): boolean {
    if (!definition || typeof definition !== 'object' || ++budget.fields > 80 || depth > 8) return false
    if (Array.isArray(definition.enum) && (definition.enum.length < 1 || definition.enum.length > 30 || enumChoices(definition).length === 0)) return false
    if (definition.type === 'object') {
      if (definition.additionalProperties !== false) return false
      const properties = definition.properties ?? {}
      if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return false
      if ((definition.required ?? []).some((name: string) => !Object.hasOwn(properties, name))) return false
      return Object.values(properties).every(child => renderableInput(child, depth + 1, budget))
    }
    if (definition.type === 'array') return Number(definition.maxItems ?? 30) <= 30 && Number(definition.minItems ?? 0) <= 30
      && renderableInput(definition.items, depth + 1, budget)
    return ['string', 'number', 'integer', 'boolean', 'null'].includes(definition.type)
  }
  function inputForm() {
    const mount = $('input-fields'), schema = info?.requirements?.inputSchema ?? {}
    mount.replaceChildren(); formReader = null
    const invalid = (message: string, control: HTMLElement): never => { control.focus(); throw Error(message) }
    const useJson = (initial?: unknown) => {
      mount.replaceChildren()
      const field = make('div', 'field'), label = make('label', undefined, 'Workflow input (JSON)') as HTMLLabelElement
      const box = document.createElement('textarea'); box.id = 'workflow-input'; box.rows = 8; label.htmlFor = box.id
      box.value = JSON.stringify(initial ?? (schema.type === 'array' ? [] : schema.type === 'object' ? {} : null), null, 2)
      field.append(label, box, make('small', undefined, 'Enter one JSON value matching this workflow’s input.'))
      mount.append(field)
      formReader = () => { try { return JSON.parse(box.value) } catch { return invalid('Enter valid JSON before running this workflow.', box) } }
    }
    if (!renderableInput(schema)) { useJson(); return }
    let sequence = 0
    type BuiltField = { element: HTMLElement; read: () => unknown }
    const field = (name: string, definition: any, required: boolean, depth = 0): BuiltField => {
      let element: HTMLElement, read: () => unknown
      if (definition.type === 'object') {
        const group = document.createElement('fieldset'); group.className = 'input-group'
        group.append(make('legend', undefined, name))
        if (definition.description) group.append(make('small', undefined, definition.description))
        const children = Object.entries(definition.properties ?? {}).map(([key, child]) => ({ key,
          built: field(key, child, (definition.required ?? []).includes(key), depth + 1) }))
        for (const child of children) group.append(child.built.element)
        element = group
        read = () => {
          const value: Record<string, unknown> = {}
          for (const child of children) { const answer = child.built.read(); if (answer !== omitted) value[child.key] = answer }
          return value
        }
      } else if (definition.type === 'array') {
        const group = document.createElement('fieldset'); group.className = 'input-group'
        group.append(make('legend', undefined, name))
        if (definition.description) group.append(make('small', undefined, definition.description))
        const list = make('div', 'array-items'), controls = make('div', 'array-controls')
        const add = make('button', 'button', 'Add item') as HTMLButtonElement; add.type = 'button'
        const entries: { row: HTMLElement; heading: HTMLElement; built: BuiltField; remove: HTMLButtonElement }[] = []
        const minimum = definition.minItems ?? 0, maximum = definition.maxItems ?? 30
        const update = () => {
          add.disabled = entries.length >= maximum
          entries.forEach((entry, index) => { entry.heading.textContent = `Item ${index + 1}`
            entry.row.setAttribute('aria-label', `Item ${index + 1}`)
            entry.remove.setAttribute('aria-label', `Remove item ${index + 1}`)
            entry.remove.disabled = entries.length <= minimum })
        }
        const addItem = () => {
          if (entries.length >= maximum) return
          const row = make('div', 'array-item'), heading = make('strong', undefined, `Item ${entries.length + 1}`)
          row.setAttribute('role', 'group')
          const built = field('Value', definition.items, true, depth + 1)
          const remove = make('button', 'button', 'Remove item') as HTMLButtonElement; remove.type = 'button'
          const entry = { row, heading, built, remove }
          remove.addEventListener('click', () => { if (entries.length <= minimum) return
            row.remove(); entries.splice(entries.indexOf(entry), 1); update() })
          row.append(heading, built.element, remove); list.append(row); entries.push(entry); update()
        }
        add.addEventListener('click', addItem); controls.append(add)
        group.append(list, controls); for (let index = 0; index < minimum; index++) addItem()
        element = group
        read = () => {
          if (entries.length < minimum || entries.length > maximum) return invalid(`Add ${name} items within the allowed range.`, add)
          return entries.map(entry => entry.built.read())
        }
      } else {
        const wrapper = make('div', 'field'), label = make('label', undefined, name) as HTMLLabelElement
        const ordinal = ++sequence
        const id = depth === 0 && schema.type === 'string' ? 'workflow-input'
          : depth === 1 && schema.type === 'object' && /^[A-Za-z][A-Za-z0-9_-]*$/u.test(name) ? `input-${name}`
            : `workflow-field-${ordinal}`
        label.htmlFor = id
        let control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
        if (Array.isArray(definition.enum)) {
          const select = document.createElement('select'), prompt = document.createElement('option')
          prompt.value = ''; prompt.textContent = 'Choose an option'; select.append(prompt); select.required = true
          const choices = enumChoices(definition)
          choices.forEach((value: unknown, index: number) => { const option = document.createElement('option')
            option.value = String(index)
            option.textContent = value === null ? 'No value' : value === true ? 'Yes' : value === false ? 'No'
              : value === '' ? '(empty text)' : String(value)
            select.append(option) })
          control = select
          read = () => { if (select.value === '') return invalid(`Choose ${name}.`, select); return choices[Number(select.value)] }
        } else if (definition.type === 'boolean') {
          const select = document.createElement('select'); select.required = true
          for (const [value, caption] of [['', 'Choose yes or no'], ['true', 'Yes'], ['false', 'No']] as const) {
            const option = document.createElement('option'); option.value = value; option.textContent = caption; select.append(option)
          }
          control = select
          read = () => { if (select.value === '') return invalid(`Choose yes or no for ${name}.`, select); return select.value === 'true' }
        } else if (definition.type === 'null') {
          const select = document.createElement('select'), option = document.createElement('option')
          option.value = 'null'; option.textContent = 'No value'; select.append(option); control = select
          read = () => null
        } else if (definition.type === 'string') {
          const box = definition.maxLength === undefined || definition.maxLength > 160
            ? document.createElement('textarea') : document.createElement('input')
          if (box instanceof HTMLInputElement) box.type = 'text'
          // HTML maxlength counts UTF-16 code units, whereas the runtime's
          // JSON Schema validator counts Unicode code points. Validate here so
          // an emoji is neither silently truncated nor counted twice.
          if (definition.minLength > 0) box.required = true
          control = box
          read = () => { const length = Array.from(box.value).length
            if (length < (definition.minLength ?? 0)) return invalid(`Enter ${name}.`, box)
            if (definition.maxLength !== undefined && length > definition.maxLength) return invalid(`${name} is too long.`, box)
            return box.value }
        } else {
          const box = document.createElement('input'); box.type = 'number'
          box.step = definition.type === 'integer' ? '1' : 'any'; box.required = true
          if (definition.minimum !== undefined) box.min = String(definition.minimum)
          if (definition.maximum !== undefined) box.max = String(definition.maximum)
          control = box
          read = () => { const value = Number(box.value)
            if (box.value === '' || !Number.isFinite(value) || (definition.type === 'integer' && !Number.isInteger(value))) return invalid(`Enter a valid number for ${name}.`, box)
            if (definition.minimum !== undefined && value < definition.minimum) return invalid(`${name} is below the allowed minimum.`, box)
            if (definition.maximum !== undefined && value > definition.maximum) return invalid(`${name} is above the allowed maximum.`, box)
            return value }
        }
        control.id = id; wrapper.append(label, control)
        if (definition.description) wrapper.append(make('small', undefined, definition.description))
        element = wrapper
      }
      if (required) return { element, read }
      const wrapper = make('div'), toggleLabel = make('label', 'include-field') as HTMLLabelElement
      const toggle = document.createElement('input'); toggle.type = 'checkbox'
      toggleLabel.append(toggle, make('span', undefined, `Include ${name}`))
      const optional = document.createElement('fieldset'); optional.className = 'input-group'
      optional.append(element); optional.hidden = true; optional.disabled = true
      toggle.addEventListener('change', () => { optional.hidden = !toggle.checked; optional.disabled = !toggle.checked })
      wrapper.append(toggleLabel, optional)
      return { element: wrapper, read: () => toggle.checked ? read() : omitted }
    }
    const built = field(schema.type === 'string' ? 'Your message' : 'Request details', schema, true)
    mount.append(built.element); formReader = built.read
    const editJson = make('button', 'button', 'Edit as JSON') as HTMLButtonElement; editJson.type = 'button'
    editJson.addEventListener('click', () => { let current: unknown
      try { current = formReader?.() } catch (error) { status(`${errorText(error)} Complete the fields before switching to JSON.`, 'error'); return }
      useJson(current); status('JSON input is ready. Review it before starting a run.') })
    mount.append(editJson)
  }
  function readInput(): unknown {
    if (!formReader) throw Error('Open this workflow before entering a request.')
    return formReader()
  }
  function showRun(run: any) {
    selectedRun = run
    const viewSeq = ++runViewSeq
    graph(run)
    const target = $('run-result'); target.replaceChildren()
    const title = make('h3', undefined, `Run ${run.status}`)
    target.append(title, make('p', undefined, `ID: ${run.id}`))
    const summary = [info?.release?.version ? `Published version ${info.release.version}` : '',
      run.createdAt ? `Started ${new Date(run.createdAt).toLocaleString()}` : '',
      run.updatedAt && run.updatedAt !== run.createdAt ? `Last changed ${new Date(run.updatedAt).toLocaleString()}` : ''].filter(Boolean)
    if (summary.length) target.append(make('p', undefined, summary.join(' · ')))
    const steps = Array.isArray(run.steps) ? run.steps : []
    if (steps.length) {
      target.append(make('h3', undefined, `${steps.length} recorded step${steps.length === 1 ? '' : 's'}`))
      const history = make('ol', 'step-history')
      for (const step of steps) {
        const item = make('li'), node = allNodes().get(step.nodeId)
        item.append(make('strong', undefined, label(node ?? step)), make('small', undefined,
          [step.port ? `Branch: ${step.port}` : '', step.startedAt ? `Started ${new Date(step.startedAt).toLocaleString()}` : '',
            Number.isFinite(step.durationMs) ? `${step.durationMs} ms` : '',
            step.scope ? `Loop ${step.scope.loop} · item ${step.scope.index + 1}` : ''].filter(Boolean).join(' · ')))
        if (step.trace?.traceId) item.append(make('code', undefined, `Trace ${step.trace.traceId} · span ${step.trace.spanId}`))
        if (step.attemptId) item.append(make('code', undefined, `Attempt ${step.attemptId}`))
        history.append(item)
      }
      target.append(history)
    }
    if (run.traceSegments?.length) {
      const traces = make('div', 'trace-list')
      traces.append(make('h3', undefined, 'Execution traces'))
      for (const segment of run.traceSegments) traces.append(make('p', undefined,
        `${segment.operation} · ${segment.trace.traceId} / ${segment.trace.spanId}${segment.previous ? ` · follows ${segment.previous.spanId}` : ''}`))
      target.append(traces)
    }
    if (run.status === 'completed') target.append(make('h3', undefined, 'Result'), valueView(run.output))
    if (run.status === 'waiting') target.append(make('p', undefined, 'Waiting for a person. Open Approvals to review the request; nothing continues automatically.'))
    if (run.status === 'failed') target.append(make('p', undefined, `Stopped at ${run.nodeId}: ${run.code}. Earlier effects are not rolled back.`))
    if (run.status === 'executing') target.append(make('p', undefined, 'This attempt may still be running or uncertain. Refresh the saved run before doing anything else.'))
    if (run.cancellation) target.append(make('p', undefined, `Cancellation ${run.cancellation.status}. External effects are not rolled back.`))
    const events = make('button', 'button', 'View audit events') as HTMLButtonElement
    events.id = 'events-run'; events.type = 'button'; events.addEventListener('click', () => {
      events.disabled = true; status('Loading saved event metadata…')
      void call('/v1/operations', 'POST', { operation: 'runs.events', id: run.id }).then((result: any) => {
        if (selectedRun?.id !== run.id || viewSeq !== runViewSeq) return
        if (result?.runId !== run.id || !Array.isArray(result.events)) throw Error('The saved events do not match this run.')
        const panel = make('div', 'audit-events')
        panel.append(make('h3', undefined, 'Saved audit events'),
          make('p', undefined, 'Event kinds and times only; private inputs and outputs are excluded.'))
        const list = make('ol')
        for (const event of result.events.slice(0, 500)) {
          const item = make('li')
          item.append(make('strong', undefined, String(event.kind ?? 'Event')),
            make('small', undefined, `Sequence ${String(event.sequence ?? '?')} · ${String(event.at ?? 'time unavailable')}`))
          list.append(item)
        }
        panel.append(list)
        if (result.events.length > 500) panel.append(make('p', undefined,
          `Showing the first 500 of ${result.events.length} events. Use the authenticated API for the complete record.`))
        target.querySelector('.audit-events')?.remove(); target.append(panel)
        status('Saved event metadata loaded without rerunning the workflow.', 'success')
      }).catch(error => status(errorText(error), 'error')).finally(() => { events.disabled = false })
    })
    target.append(events)
    const inspect = make('button', 'button', 'View recorded values') as HTMLButtonElement
    inspect.id = 'inspect-run'; inspect.type = 'button'; inspect.addEventListener('click', () => {
      inspect.disabled = true
      status('Loading private recorded values…')
      void call('/v1/operations', 'POST', { operation: 'runs.inspect', id: run.id }).then((result: any) => {
        if (selectedRun?.id !== run.id || viewSeq !== runViewSeq) return
        const values = make('div', 'private-values')
        values.append(make('h3', undefined, 'Private recorded values'),
          make('p', undefined, 'These may contain personal or confidential data. Do not share a screenshot without checking them.'))
        values.append(make('h3', undefined, 'Original input'), valueView(result.run.input))
        if (result.run.caller?.grantId) values.append(make('h3', undefined, 'Started through API grant'),
          make('p', undefined, result.run.caller.grantId))
        for (const [index, step] of result.run.state.steps.entries()) {
          values.append(make('h3', undefined, `${index + 1}. ${label(allNodes().get(step.nodeId) ?? step)}`),
            valueView(step.output))
          const decision = step.inspection?.approval
          if (decision?.kind === 'action') values.append(make('p', undefined,
            `Approval: ${decision.action} · by ${decision.actor} · ${new Date(decision.at).toLocaleString()}`))
          else if (decision?.kind === 'expired') values.append(make('p', undefined,
            `Approval expired ${new Date(decision.at).toLocaleString()}`))
        }
        target.querySelector('.private-values')?.remove()
        target.append(values); status('Private values loaded for this run.', 'success')
      }).catch(error => status(errorText(error), 'error')).finally(() => { inspect.disabled = false })
    })
    target.append(inspect)
    target.hidden = false
    $('refresh-run').hidden = false
  }
  async function refreshRun(id: string) {
    const run = await call('/v1/operations', 'POST', { operation: 'runs.show', id })
    showRun(run)
    if (pendingRun?.id === id) { pendingRun = null; $('run-button').textContent = 'Run workflow' }
    status('Saved run refreshed.', 'success')
    return run
  }
  async function refreshRuns(more = false) {
    const seq = ++runPageSeq, after = more ? runCursor : null
    if (more && !after) return
    const page = await call('/v1/operations', 'POST', { operation: 'runs.list', page: { limit: 100, ...(after ? { after } : {}) } })
    if (seq !== runPageSeq) return
    const list = $('run-list'); if (!more) list.replaceChildren()
    if (!page.runs?.length && !more) list.append(make('li', 'empty', 'No runs yet. Use Run to try this workflow.'))
    if (more) list.querySelector('.empty')?.remove()
    for (const run of page.runs) {
      const row = make('li'), label = make('span')
      label.append(make('strong', undefined, `Run ${run.status}`), make('small', undefined, run.id))
      const button = make('button', 'button', 'View run') as HTMLButtonElement
      button.type = 'button'; button.addEventListener('click', () => { void refreshRun(run.id).then(() => selectTab('run')).catch(error => status(errorText(error), 'error')) })
      row.append(label, button); list.append(row)
    }
    runCursor = page.nextCursor ?? null
    $('run-more').hidden = !runCursor
  }
  async function refreshApprovals(more = false) {
    const seq = ++approvalPageSeq, after = more ? approvalCursor : null
    if (more && !after) return
    const page = await call('/v1/operations', 'POST', { operation: 'approvals.list', page: { limit: 100, ...(after ? { after } : {}) } })
    if (seq !== approvalPageSeq) return
    const list = $('approval-list'); if (!more) { list.replaceChildren(); $('approval-review').hidden = true; $('approval-review').replaceChildren() }
    if (!page.tasks?.length && !list.querySelector('li')) list.append(make('li', 'empty',
      page.nextCursor ? 'No decisions on this page. Continue to the next page.' : 'No decisions are waiting.'))
    if (page.tasks?.length) list.querySelector('.empty')?.remove()
    for (const task of page.tasks) {
      const row = make('li'), label = make('span')
      label.append(make('strong', undefined, 'Request awaiting a decision'),
        make('small', undefined, `Run ${task.runId} · due ${new Date(task.expiresAt).toLocaleString()}`))
      const button = make('button', 'button', 'View request') as HTMLButtonElement
      button.type = 'button'; button.addEventListener('click', () => { void review(task).catch(error => status(errorText(error), 'error')) })
      row.append(label, button); list.append(row)
    }
    approvalCursor = page.nextCursor ?? null
    $('approval-more').hidden = !approvalCursor
  }
  async function review(task: any) {
    const current = await call('/v1/operations', 'POST', { operation: 'approvals.show', id: task.runId })
    if (current.status !== 'waiting' || current.attemptId !== task.attemptId) throw Error('This request changed. Refresh the approval list.')
    const panel = $('approval-review'); panel.replaceChildren()
    panel.append(make('h3', undefined, String(current.review?.input?.title ?? 'Decision requested')),
      make('p', undefined, `Run ${task.runId} · step ${task.nodeId}`),
      valueView(current.review?.input?.input))
    const check = document.createElement('input'); check.type = 'checkbox'; check.id = 'approval-confirm'
    const acknowledgement = make('label', 'check') as HTMLLabelElement; acknowledgement.htmlFor = check.id
    acknowledgement.append(check, make('span', undefined, 'I have read this request and am ready to decide.'))
    panel.append(acknowledgement)
    const actions = make('div', 'actions'), node = allNodes().get(task.nodeId), names: string[] = node?.actions ?? []
    for (const name of names) {
      const button = make('button', 'button', name === 'approve' || name === 'reject'
        ? name : fieldName(name).replace(/^./u, c => c.toUpperCase())) as HTMLButtonElement
      button.type = 'button'; button.disabled = true
      check.addEventListener('change', () => { button.disabled = !check.checked || busy })
      button.addEventListener('click', () => {
        if (!check.checked || busy) return
        busy = true; for (const child of actions.querySelectorAll<HTMLButtonElement>('button')) child.disabled = true
        status('Recording the decision…')
        void call('/v1/operations', 'POST', { operation: 'approvals.decide', id: task.runId, attemptId: task.attemptId, action: name })
          .then((run: any) => { showRun(run); panel.hidden = true; selectTab('run'); status('Decision recorded. Inspect the saved run for its outcome.', 'success') })
          .catch(error => status(`${errorText(error)} Outcome may be uncertain; refresh the saved run before deciding again.`, 'error'))
          .finally(() => { busy = false })
      })
      actions.append(button)
    }
    if (!names.length) panel.append(make('p', undefined, 'Decision actions are unavailable. Do not guess an action; contact the workflow owner.'))
    panel.append(actions); panel.hidden = false; panel.tabIndex = -1; panel.focus()
    if (reviewerEnabled) {
      const allowed = names
      if (allowed.length) {
        const share = make('div', 'private-values')
        share.append(make('h3', undefined, 'Give someone access to this request'),
          make('p', undefined, 'Create a private review token for this request only. They can open the review page without your owner token.'))
        const create = make('button', 'button', 'Create review token') as HTMLButtonElement
        const retry = make('button', 'button', 'Check same token request') as HTMLButtonElement; retry.hidden = true
        const result = make('div', 'readout'); result.hidden = true
        let command: { operation: 'reviewers.issue'; id: string; tokenSha256: string; runId: string; attemptId: string;
          expiresAt: string; decisions: string[] } | null = null
        let secret = '', issuing = false
        const issue = async () => {
          if (!command || issuing) return
          const epoch = sessionEpoch
          issuing = true; create.disabled = true; retry.disabled = true; status('Creating this request’s review access…')
          try {
            const grant = await call('/v1/operations', 'POST', command)
            if (epoch !== sessionEpoch) return
            if (grant.id !== command.id || grant.scope?.runId !== task.runId || grant.scope?.attemptId !== task.attemptId)
              throw Error('The review access receipt did not match this request.')
            result.replaceChildren(make('p', undefined, 'Send the review page and this token privately. It is shown here only until you leave this request.'))
            const link = document.createElement('a'); link.href = '/review'; link.textContent = 'Open review page (no token in link)'
            const tokenField = document.createElement('input'); tokenField.type = 'text'; tokenField.readOnly = true
            tokenField.value = secret; tokenField.setAttribute('aria-label', 'One-time review token')
            tokenField.addEventListener('focus', () => tokenField.select())
            result.append(link, tokenField, make('small', undefined, `Expires ${new Date(command.expiresAt).toLocaleString()}. Copy it now; the service cannot recover it.`))
            result.hidden = false; retry.hidden = true; status('Review access created for this request only.', 'success')
          } catch (error) {
            if (epoch !== sessionEpoch) return
            retry.hidden = false; status(`${errorText(error)} Access may already exist. Check the same token request; do not create a new one.`, 'error')
          } finally { issuing = false; retry.disabled = false }
        }
        create.addEventListener('click', () => {
          if (command || issuing || create.disabled) return
          const epoch = sessionEpoch, id = crypto.randomUUID(), bytes = crypto.getRandomValues(new Uint8Array(32))
          secret = `jvg1.${id}.${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
          const deadline = Math.min(Date.now() + 3_600_000, Date.parse(task.expiresAt))
          if (!Number.isFinite(deadline) || deadline <= Date.now()) { status('This request has expired. Refresh the list.', 'error'); return }
          create.disabled = true
          void crypto.subtle.digest('SHA-256', new TextEncoder().encode('jevable/delegated-grant/v1\0' + secret))
            .then(digest => {
              if (epoch !== sessionEpoch) return
              command = { operation: 'reviewers.issue', id,
                tokenSha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''),
                runId: task.runId, attemptId: task.attemptId, expiresAt: new Date(deadline).toISOString(), decisions: allowed }
              return issue()
            }).catch(error => { if (epoch === sessionEpoch) { create.disabled = false; status(errorText(error), 'error') } })
        })
        retry.addEventListener('click', () => { void issue() })
        share.append(create, retry, result); panel.append(share)
      }
    }
  }
  function selectTab(name: string) {
    activeTab = name
    for (const tab of ['run', 'log', 'approvals', 'guide']) {
      $(`tab-${tab}`).hidden = tab !== name
      const button = $(`nav-${tab}`)
      if (tab === name) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current')
    }
    if (name === 'log') void refreshRuns().catch(error => status(errorText(error), 'error'))
    if (name === 'approvals') void refreshApprovals().catch(error => status(errorText(error), 'error'))
  }
  $('login-form').addEventListener('submit', event => {
    event.preventDefault()
    const candidate = ($('owner-token') as HTMLInputElement).value.trim()
    if (!/^[a-f0-9]{64}$/.test(candidate)) { status('Enter the 64-character owner token from the deployment operator.', 'error'); return }
    const epoch = ++sessionEpoch
    token = candidate
    status('Connecting…')
    void call('/v1/capabilities', 'GET').then(async caps => {
      if (caps.mode !== 'release-execution' || !/^[a-f0-9]{64}$/.test(caps.release?.sha256 ?? '')) throw Error('This is not a published workflow runtime.')
      protocol = caps.protocolVersion; pin = caps.release.sha256
      info = await call('/v1/operations', 'POST', { operation: 'release.info' })
      if (info.release?.sha256 !== pin) throw Error('The published workflow changed. Reconnect to the intended release.')
      document.title = `${info.graph.name} · Jevable`
      $('workflow-title').textContent = info.graph.name
      $('workflow-description').textContent = info.graph.description ?? 'Run this published workflow and inspect its saved steps.'
      $('login').hidden = true; $('workspace').hidden = false; ($('owner-token') as HTMLInputElement).value = ''
      $('workspace-nav').hidden = false; $('signout').hidden = false
      inputForm(); graph(); selectTab(activeTab); status('Connected. Opening the workflow did not run it.', 'success')
    }).catch(error => { if (epoch !== sessionEpoch) return; token = ''; protocol = ''; pin = ''; info = null; status(errorText(error), 'error') })
  })
  $('signout').addEventListener('click', () => {
    sessionEpoch++; runPageSeq++; approvalPageSeq++; runViewSeq++
    token = ''; pin = ''; protocol = ''; info = null; selectedRun = null; pendingRun = null; formReader = null
    runCursor = null; approvalCursor = null; busy = false
    $('workspace').hidden = true; $('login').hidden = false; $('run-result').hidden = true; $('refresh-run').hidden = true
    $('workspace-nav').hidden = true; $('signout').hidden = true
    $('run-more').hidden = true; $('approval-more').hidden = true
    apiPanel.replaceChildren(); apiPanel.hidden = true
    for (const id of ['input-fields', 'run-result', 'run-list', 'approval-list', 'approval-review', 'flow-columns', 'flow-lines']) $(id).replaceChildren();
    ($('owner-token') as HTMLInputElement).value = '';
    ($('run-button') as HTMLButtonElement).disabled = false; $('run-button').textContent = 'Run workflow';
    document.title = 'Published workflow · Jevable'
    $('workflow-title').textContent = ''; $('workflow-description').textContent = ''
    status('Signed out. Saved runs remain on the workflow runtime.');
    ($('owner-token') as HTMLInputElement).focus()
  })
  for (const name of ['run', 'log', 'approvals', 'guide']) $('nav-' + name).addEventListener('click', () => selectTab(name))
  $('run-form').addEventListener('submit', event => {
    event.preventDefault(); if (busy) return
    if (!pendingRun) {
      try { pendingRun = { operation: 'runs.start', id: crypto.randomUUID(), input: readInput() } }
      catch (error) { status(errorText(error), 'error'); return }
    }
    busy = true; ($('run-button') as HTMLButtonElement).disabled = true
    status('Submitting this exact run ID…')
    void call('/v1/operations', 'POST', pendingRun).then((run: any) => {
      pendingRun = null; $('run-button').textContent = 'Run workflow'; showRun(run)
      status(run.status === 'waiting' ? 'Run saved and waiting for a decision.' : `Run saved: ${run.status}.`, 'success')
    }).catch(error => { $('run-button').textContent = 'Retry same request'; $('refresh-run').hidden = false
      status(`${errorText(error)} This run may have started. Refresh ID ${pendingRun?.id ?? ''}; retry uses the same ID and input.`, 'error') })
      .finally(() => { busy = false; ($('run-button') as HTMLButtonElement).disabled = false })
  })
  $('refresh-run').addEventListener('click', () => {
    const id = selectedRun?.id ?? pendingRun?.id
    if (id) void refreshRun(id).catch(error => status(errorText(error), 'error'))
  })
  $('refresh-log').addEventListener('click', () => { void refreshRuns().catch(error => status(errorText(error), 'error')) })
  $('refresh-approvals').addEventListener('click', () => { void refreshApprovals().catch(error => status(errorText(error), 'error')) })
  $('run-more').addEventListener('click', () => { void refreshRuns(true).catch(error => status(errorText(error), 'error')) })
  $('approval-more').addEventListener('click', () => { void refreshApprovals(true).catch(error => status(errorText(error), 'error')) })
  apiButton.addEventListener('click', () => {
    apiButton.disabled = true
    void call('/v1/openapi.json', 'GET').then((spec: any) => {
      apiPanel.replaceChildren()
      apiPanel.append(make('h3', undefined, `${spec.info.title} · ${spec.openapi}`),
        make('p', undefined, 'Use the owner token in the Authorization header, never in a URL. Replace the sample release hash and UUID with your saved values.'))
      for (const [path, methods] of Object.entries(spec.paths) as [string, any][]) {
        for (const [method, detail] of Object.entries(methods) as [string, any][]) {
          apiPanel.append(make('h3', undefined, `${method.toUpperCase()} ${path}`), make('p', undefined, detail.summary))
        }
      }
      const examples = spec.paths['/v1/operations'].post.requestBody.content['application/json'].examples
      apiPanel.append(make('h3', undefined, 'Example requests'))
      for (const example of Object.values(examples) as any[]) apiPanel.append(make('p', undefined, example.summary),
        make('pre', undefined, JSON.stringify(example.value, null, 2)))
      const full = document.createElement('details'), summary = make('summary', undefined, 'Full OpenAPI JSON')
      full.append(summary, make('pre', undefined, JSON.stringify(spec, null, 2))); apiPanel.append(full)
      apiPanel.hidden = false
    }).catch(error => status(errorText(error), 'error')).finally(() => { apiButton.disabled = false })
  })
  window.addEventListener('resize', () => { if (info && activeTab === 'run') graph(selectedRun) })
}

const script = `(${releaseBrowser.toString()})()`
const hash = (value: string) => createHash('sha256').update(value).digest('base64')

/** Inert public shell: no release source, run, token or account data is embedded.
 * Authenticated browser requests are same-origin and explicit user actions only.
 */
export function renderReleasePage(reviewerDecisions = false) {
  const styles = css + historyCss
  const csp = `default-src 'none'; script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(styles)}'; connect-src 'self'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Published workflow · Jevable</title><style>${styles}</style></head><body><a class="skip" href="#main">Skip to main content</a><header class="top"><div class="brand">${mark}<span>jevable</span></div><small>Published workflow runtime</small><nav aria-label="Workflow sections" id="workspace-nav"><button id="nav-run" type="button" aria-current="page">Run</button><button id="nav-log" type="button">Log</button><button id="nav-approvals" type="button">Approvals</button><button id="nav-guide" type="button">Guide</button></nav><button id="signout" class="signout" type="button">Sign out</button></header><main id="main" class="shell"><p id="status" class="status" role="status" aria-live="polite"></p><section id="login" class="card login"><h1>Open this workflow</h1><p>Enter the owner token supplied by the person who deployed this workflow. Opening is read-only; a run starts only when you choose Run workflow.</p><form id="login-form"><div class="field"><label for="owner-token">Owner token</label><input id="owner-token" type="password" autocomplete="off" required><small>This token can run workflows, inspect private results and decide approvals. Use it only on a trusted device.</small></div><button class="button primary" type="submit">Open workflow</button></form></section><div id="workspace" hidden><div class="intro"><h1 id="workflow-title"></h1><p id="workflow-description"></p></div><section id="tab-run" aria-label="Run workflow"><div class="split"><div class="card"><h2>Try a request</h2><p>Runs may contact configured services. Review your input, then start one saved run.</p><form id="run-form"><div id="input-fields"></div><button id="run-button" class="button primary" type="submit">Run workflow</button></form><div class="actions"><button id="refresh-run" class="button" type="button" hidden>Refresh saved run</button></div><div id="run-result" class="readout" hidden></div></div><div class="card"><div class="panel-head"><h2>Workflow path</h2><small>Left to right</small></div><div class="flow-viewport" role="group" aria-label="Workflow diagram"><div id="flow-canvas" class="flow-canvas"><svg id="flow-lines" class="flow-lines" aria-hidden="true"></svg><div id="flow-columns" class="flow-columns"></div></div></div><p class="note">A Decision · Jev step makes a typed choice, so the workflow can follow a reviewed branch. The diagram reflects the saved run; looking at it never executes a step.</p></div></div></section><section id="tab-log" aria-label="Run log" hidden><div class="card"><div class="panel-head"><h2>Saved runs</h2><button id="refresh-log" class="button" type="button">Refresh list</button></div><p>Read a saved run without starting it again. Load more for older records.</p><ul id="run-list" class="list"></ul></div></section><section id="tab-approvals" aria-label="Approvals" hidden><div class="card"><div class="panel-head"><h2>Needs a decision</h2><button id="refresh-approvals" class="button" type="button">Refresh list</button></div><p>Opening a request does not approve it. Read the exact request and confirm before choosing an action.</p><ul id="approval-list" class="list"></ul><div id="approval-review" class="readout" hidden></div></div></section><section id="tab-guide" aria-label="Guide" hidden><div class="intro"><h2>Start here</h2><p>This container is the runnable workflow app, not just a diagram or YAML file. Its runs and decisions are saved by the configured runtime storage.</p></div><div class="guide"><div class="card"><h3>1. Run</h3><p>Enter a sample request and choose Run workflow. The result and highlighted path use the exact published version.</p></div><div class="card"><h3>2. Follow the record</h3><p>Use Log to reopen a saved run. Refresh a pending run rather than submitting a new ID after a connection problem.</p></div><div class="card"><h3>3. Decide when asked</h3><p>Approvals shows waiting requests. Read one, tick the confirmation, then choose its named action. Opening never approves.</p></div><div class="card"><h3>API and telemetry</h3><p>The same app exposes authenticated <code>/v1/capabilities</code>, <code>/v1/health</code> and <code>/v1/operations</code>. Your operator can configure OpenTelemetry export; an unavailable collector never substitutes for the saved run record.</p></div></div><p class="note">The owner token grants every release operation, including private inspection and approvals. This page has no separate reviewer role. Do not share the token or paste it into URLs.</p></section></div></main><footer class="footer">Jevable · Exact published release · Opening this page never runs a workflow.</footer><noscript>This app needs JavaScript. Use the authenticated JSON API or bundled CLI instead.</noscript><script>${script}</script></body></html>`
  return { html: reviewerDecisions ? html.replace('<body>', '<body data-reviewer-decisions="true">')
    .replace('</form></section><div id="workspace"', '</form><p>Only reviewing a request? <a href="/review">Open your private review page</a>.</p></section><div id="workspace"')
    .replace('This page has no separate reviewer role. Do not share the token or paste it into URLs.',
      'Use the separate review page for a one-request reviewer token. Do not share the owner token or paste any token into a URL.') : html, csp }
}
