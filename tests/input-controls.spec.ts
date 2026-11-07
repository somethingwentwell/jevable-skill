import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { schemaInputTools } from '../src/preview/input-model.ts'
import { liveInputControls, inputControlsHtml } from '../src/preview/input-controls.ts'
import { compileValueSchema, validateWorkflowValue } from '../src/workflow/index.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'

const tools = schemaInputTools()
const s = { type: 'object', required: ['title', 'amount', 'active', 'choice', 'rows'], properties: {
  title: { type: 'string', minLength: 1 }, amount: { type: 'number', minimum: 0 }, active: { type: 'boolean' },
  choice: { type: 'integer', enum: [0, 1] }, optional: { type: 'null' }, empty: { type: 'string' },
  rows: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false }, maxItems: 3 },
} }
const value = { title: 'Private\r\nmultiline\rtext', amount: 0, active: false, choice: 0, rows: [{ code: 'x' }], extra: { secret: 'PRIVATE_EXTRA' } }

describe('bounded, serializable schema input tools', () => {
  it.each([
    [{ type: 'string', minLength: 1, maxLength: 1 }, '😀', true],
    [{ type: 'string', minLength: 1, maxLength: 1 }, '', false],
    [{ type: 'string', minLength: 1, maxLength: 1 }, 'ab', false],
    [{ type: 'integer', minimum: 1, maximum: 2 }, 1.5, false],
    [{ type: 'integer', minimum: 1, maximum: 2 }, 2, true],
    [{ type: 'number', minimum: 0, maximum: 1 }, 0.1, true],
    [{ type: 'number', minimum: 0, maximum: 1 }, -1, false],
    [{ type: 'number', enum: [1, 2] }, '1', false],
    [{ type: 'number', enum: [1, 2] }, 1, true],
    [{ type: 'boolean' }, false, true], [{ type: 'boolean' }, 0, false], [{ type: 'null' }, null, true],
    [{ type: 'array', minItems: 1, maxItems: 2, items: { type: 'string' } }, [], false],
    [{ type: 'array', minItems: 1, maxItems: 2, items: { type: 'string' } }, ['x'], true],
    [{ type: 'array', minItems: 1, maxItems: 2, items: { type: 'string' } }, ['x', 'y', 'z'], false],
    [{ type: 'object', properties: { n: { type: 'null' } }, required: ['n'], additionalProperties: false }, { n: null }, true],
    [{ type: 'object', properties: { n: { type: 'null' } }, required: ['n'], additionalProperties: false }, {}, false],
    [{ type: 'object', additionalProperties: false }, { extra: 1 }, false],
    [{ type: 'object' }, { extra: ['x'] }, true],
  ])('agrees with actual runtime admission for %j / %j', (schema, input, valid) => {
    const admitted = tools.schema(schema), compiled = compileValueSchema(schema, DEFAULT_COMPILER_LIMITS.schema)
    if (valid) { expect(tools.validate(admitted, input)).toEqual(input); expect(validateWorkflowValue(compiled, input, DEFAULT_COMPILER_LIMITS.binding.data)).toEqual(input) }
    else { expect(() => tools.validate(admitted, input)).toThrow(); expect(() => validateWorkflowValue(compiled, input, DEFAULT_COMPILER_LIMITS.binding.data)).toThrow() }
  })
  it.each(['', ' ', '01', 'NaN', 'Infinity', '1e999', '0x10', '+2', '3.', '1,234'])('never turns invalid numeric text %j into a run input', text => {
    expect(() => tools.scalar({ type: 'number' }, text)).toThrow()
  })
  it('preserves scalar distinctions without coercing strings, false, zero or null', () => {
    expect(tools.scalar({ type: 'string' }, '0')).toBe('0')
    expect(tools.scalar({ type: 'boolean' }, 'false')).toBe(false)
    expect(tools.scalar({ type: 'number' }, '0')).toBe(0)
    expect(tools.scalar({ type: 'number' }, '1.25e-2')).toBe(0.0125)
    expect(tools.scalar({ type: 'null' }, 'null')).toBeNull()
    expect(tools.scalar({ type: 'string', enum: ['false', '0'] }, '0')).toBe('false')
    expect(() => tools.scalar({ type: 'integer' }, '1.25')).toThrow()
  })
  it.each(['{"__proto__":{"polluted":true}}', '{"constructor":0}', '{"prototype":1}', '[null,]'])('refuses unsafe/non-JSON values without returning their text', text => {
    expect(() => tools.parse(text)).toThrow(); expect(Object.prototype).not.toHaveProperty('polluted')
  })
  it('limits schemas and values without truncating a JSON fallback', () => {
    const input = Array.from({ length: 33 }, (_, i) => i), schema = tools.schema({ type: 'array', items: { type: 'integer' } })
    expect(tools.parse(JSON.stringify(input))).toEqual(input)
    expect(() => tools.compatible(schema, input)).toThrow(/32 items/)
    expect(() => tools.schema({ type: 'string', pattern: '.*' })).toThrow(/unsupported/)
    expect(() => tools.schema({ type: 'object', properties: Object.fromEntries(Array.from({ length: 129 }, (_, i) => ['k' + i, { type: 'string' }])) })).toThrow()
    expect(() => tools.parse(JSON.stringify('x'.repeat(1_000_001)))).toThrow()
    expect(() => tools.snapshot([undefined])).toThrow()
    const cyclic: any = {}; cyclic.next = cyclic; expect(() => tools.snapshot(cyclic)).toThrow()
  })
})

/** Deliberately minimal DOM double. This tests serialized logic, not a browser or visual accessibility. */
class Element {
  private text = ''; private content = ''; id = ''; type = ''; checked = false; disabled = false; hidden = false; className = ''; spellcheck = false
  attributes = new Map<string, string>(); children: Element[] = []; listeners = new Map<string, (() => void)[]>()
  constructor(readonly tagName: string) {}
  set value(value: string) { this.content = this.tagName === 'TEXTAREA' ? String(value).replace(/\r\n?/g, '\n') : String(value) }
  get value() { return this.content }
  set textContent(value: string) { this.text = value; this.children = [] }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(' ') }
  set innerHTML(_value: string) { throw Error('Dynamic markup is forbidden') }
  append(...children: Element[]) { this.children.push(...children) }
  replaceChildren(...children: Element[]) { this.children = children; this.text = '' }
  setAttribute(key: string, value: string) { this.attributes.set(key, value) }
  addEventListener(name: string, fn: () => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], fn]) }
  fire(name = 'click') { for (const fn of this.listeners.get(name) ?? []) fn() }
}
function editor(schema: unknown, input: unknown) {
  const elements = new Map([...inputControlsHtml.matchAll(/id="([^"]+)"/g)].map(match => [match[1]!, new Element(match[1] === 'live-input' ? 'TEXTAREA' : 'DIV')]))
  const get = (id: string) => elements.get(id)!
  get('live-input').value = JSON.stringify(input, null, 2)
  const context = { schema: JSON.stringify(schema), document: { getElementById: get, createElement: (name: string) => new Element(name.toUpperCase()) }, TextEncoder }
  const controller = runInNewContext(`const tools = (${schemaInputTools.toString()})(); (${liveInputControls.toString()})(JSON.parse(schema), tools)`, context) as ReturnType<typeof liveInputControls>
  const all = (node = get('input-fields')): Element[] => [node, ...node.children.flatMap(child => all(child))]
  const field = (name: string) => {
    const box = all().find(node => node.tagName === 'FIELDSET' && node.children[0]?.textContent === name)!
    return box.children.find(node => ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName) && node.type !== 'checkbox')!
  }
  const button = (text: string) => all().find(node => node.tagName === 'BUTTON' && node.textContent === text)!
  const include = (name: string) => { const label = all().find(node => node.tagName === 'LABEL' && node.textContent.startsWith('Include ' + name + ' ('))!; return all().find(node => node.id === label.attributes.get('for'))! }
  return { controller, get, all, field, button, include }
}

describe('serialized field editor (not browser qualification)', () => {
  it('round-trips nested data, unknown properties, null/false/zero and untouched CRLF strings', () => {
    const f = editor(s, value)
    expect(f.controller.mode()).toBe('fields'); expect(f.controller.read()).toEqual(value)
    f.get('input-use-json').fire(); expect(JSON.parse(f.get('live-input').value)).toEqual(value)
    f.get('input-use-fields').fire(); expect(f.controller.read()).toEqual(value)
    expect(f.field('title').value).toBe(value.title.replace(/\r\n?/g, '\n'))
    f.field('title').value = 'explicit edit'; expect(f.controller.read().title).toBe('explicit edit')
  })
  it('edits typed fields and optional presence without inventing null or dropping extra properties', () => {
    const f = editor(s, value)
    f.field('amount').value = '1.5'; f.field('active').value = 'true'; f.field('choice').value = '1'
    f.include('optional').checked = true; f.include('optional').fire('change')
    f.include('empty').checked = true; f.include('empty').fire('change')
    expect(f.controller.read()).toEqual({ ...value, amount: 1.5, active: true, choice: 1, optional: null, empty: '' })
    f.include('empty').checked = false; f.include('empty').fire('change')
    expect(f.controller.read()).not.toHaveProperty('empty')
  })
  it('adds/removes array rows without executing, including removing a malformed numeric row', () => {
    const f = editor({ type: 'array', items: { type: 'number' }, maxItems: 3 }, [1, 2])
    f.field('Item 1').value = ''
    f.button('Remove item 1').fire()
    expect(f.controller.read()).toEqual([2])
    f.button('Add item').fire(); expect(f.controller.read()).toEqual([2, 0])
    f.field('Item 2').value = '3'; f.button('Add item').fire(); expect(f.controller.read()).toEqual([2, 3, 0])
    expect(f.button('Add item').disabled).toBe(true)
  })
  it('keeps invalid numeric drafts in fields and refuses mode changes/read without replacing JSON', () => {
    const f = editor(s, value), before = f.get('live-input').value
    f.field('amount').value = ''
    f.get('input-use-json').fire()
    expect(f.controller.mode()).toBe('fields'); expect(f.get('live-input').value).toBe(before)
    expect(f.get('input-message').textContent).toContain('blank is not zero'); expect(() => f.controller.read()).toThrow()
    f.field('amount').value = '-1'; expect(() => f.controller.read()).toThrow(/does not meet/)
    f.get('input-use-json').fire(); expect(JSON.parse(f.get('live-input').value).amount).toBe(-1)
  })
  it('keeps invalid JSON and incompatible/oversized values intact instead of coercing or truncating', () => {
    const f = editor({ type: 'array', items: { type: 'integer' } }, Array.from({ length: 33 }, (_, i) => i))
    expect(f.controller.mode()).toBe('json'); expect(f.controller.read()).toHaveLength(33)
    f.get('live-input').value = 'PRIVATE_INVALID_JSON'; f.get('input-use-fields').fire()
    expect(f.get('live-input').value).toBe('PRIVATE_INVALID_JSON'); expect(f.get('input-message').textContent).not.toContain('PRIVATE_INVALID_JSON')
    f.get('live-input').value = '["1"]'; f.get('input-use-fields').fire(); expect(() => f.controller.read()).toThrow(/whole number/)
    expect(f.get('live-input').value).toBe('["1"]')
    expect(f.controller.mode()).toBe('json')
    f.get('live-input').value = '[1]'; f.get('input-use-fields').fire(); expect(f.controller.mode()).toBe('fields')
  })
  it('never allows additional-properties JSON to replace a declared field or inject prototype keys', () => {
    const f = editor(s, value), extra = f.get('input-fields').children[0]!.children
      .find(node => node.tagName === 'DETAILS')!.children.find(node => node.id.endsWith('-extra'))!
    extra.value = '{"amount":42}'; expect(() => f.controller.read()).toThrow(/declared properties/)
    extra.value = '{"__proto__":{"polluted":true}}'; expect(() => f.controller.read()).toThrow(/bounded JSON/)
    expect(Object.prototype).not.toHaveProperty('polluted')
  })
  it('renders hostile labels, descriptions and enum strings only as text, with associated labels', () => {
    const payload = '</script><img src=x onerror=alert(1)>', f = editor({ type: 'string', description: payload, enum: [payload, 'safe'] }, payload)
    expect(f.controller.read()).toBe(payload)
    expect(f.all().some(node => node.tagName === 'IMG')).toBe(false)
    expect(f.all().some(node => node.tagName === 'P' && node.textContent === payload)).toBe(true)
    expect(f.all().some(node => node.tagName === 'LABEL' && node.attributes.get('for') === f.field('Input').id)).toBe(true)
  })
  it('preserves a required field omission until explicitly included and never submits a synthesized empty value', () => {
    const f = editor({ type: 'object', properties: { must: { type: 'string' } }, required: ['must'] }, {})
    expect(f.controller.mode()).toBe('fields'); expect(() => f.controller.read()).toThrow(/does not meet/)
    f.get('input-use-json').fire(); expect(JSON.parse(f.get('live-input').value)).toEqual({})
    f.get('input-use-fields').fire(); f.include('must').checked = true; f.include('must').fire('change')
    expect(f.controller.read()).toEqual({ must: '' })
  })
})
