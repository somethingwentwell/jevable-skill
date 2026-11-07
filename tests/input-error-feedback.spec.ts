import { describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { schemaInputTools } from '../src/preview/input-model.ts'
import { inputControlsHtml, liveInputControls } from '../src/preview/input-controls.ts'
import { compileValueSchema, validateWorkflowValue } from '../src/workflow/index.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'

describe('plain-language input corrections without private values', () => {
  const tools = schemaInputTools()
  it.each([
    [{ type: 'string' }, 17, 'Enter text.'],
    [{ type: 'number' }, 'PRIVATE_BAD_NUMBER', 'Enter a number.'],
    [{ type: 'integer' }, 1.2, 'Enter a whole number.'],
    [{ type: 'boolean' }, 'PRIVATE_BAD_BOOLEAN', 'Choose true or false.'],
    [{ type: 'null' }, 'PRIVATE_NOT_NULL', 'Use null.'],
    [{ type: 'object' }, [], 'Enter an object with named fields.'],
    [{ type: 'array', items: { type: 'string' } }, {}, 'Enter a list of items.'],
    [{ type: 'string', minLength: 2 }, '😀', 'Enter at least 2 characters.'],
    [{ type: 'string', maxLength: 1 }, 'PRIVATE_TOO_LONG', 'Use no more than 1 character.'],
    [{ type: 'number', minimum: 0 }, -1, 'Enter a number of at least 0.'],
    [{ type: 'number', maximum: 2 }, 3, 'Enter a number no greater than 2.'],
    [{ type: 'array', items: { type: 'null' }, minItems: 1 }, [], 'Include at least 1 item.'],
    [{ type: 'array', items: { type: 'null' }, maxItems: 1 }, [null, null], 'Use no more than 1 item.'],
    [{ type: 'string', enum: ['first', 'second'] }, 'PRIVATE_UNKNOWN_CHOICE', 'Choose one of the listed values.'],
  ])('explains the same rejection as runtime admission for %j', (schema, input, correction) => {
    const admitted = tools.schema(schema), compiled = compileValueSchema(schema, DEFAULT_COMPILER_LIMITS.schema)
    expect(() => validateWorkflowValue(compiled, input, DEFAULT_COMPILER_LIMITS.binding.data)).toThrow()
    expect(() => tools.validate(admitted, input)).toThrow('Input: ' + correction)
    try { tools.validate(admitted, input) } catch (failure) { expect(String(failure)).not.toContain('PRIVATE_') }
  })
  it('identifies the first nested field and one-based item without including its value', () => {
    const schema = tools.schema({ type: 'object', properties: { rows: { type: 'array', items: {
      type: 'object', properties: { amount: { type: 'number', minimum: 0 } }, required: ['amount'],
    } } }, required: ['rows'] })
    expect(() => tools.validate(schema, { rows: [{ amount: 0 }, { amount: -1 }] }))
      .toThrow('Input → rows → Item 2 → amount: Enter a number of at least 0.')
    expect(() => tools.validate(schema, { rows: [{}] }))
      .toThrow('Input → rows → Item 1 → amount: Include this required field.')
  })
  it('does not echo an undeclared private property name or payload', () => {
    const schema = tools.schema({ type: 'object', properties: {}, additionalProperties: false })
    expect(() => tools.validate(schema, { PRIVATE_KEY_NAME: 'PRIVATE_VALUE' })).toThrow('Remove additional fields')
    try { tools.validate(schema, { PRIVATE_KEY_NAME: 'PRIVATE_VALUE' }) } catch (failure) {
      expect(String(failure)).not.toContain('PRIVATE_')
    }
  })
  it('bounds hostile schema labels while retaining exact validation and untouched input', () => {
    const name = 'a'.repeat(1000), schema = tools.schema({ type: 'object', properties: { [name]: { type: 'string', minLength: 1 } }, required: [name] })
    const input = { [name]: '' }
    try { tools.validate(schema, input) } catch (failure) {
      expect(String(failure).length).toBeLessThan(600); expect(String(failure)).toContain('…')
    }
    expect(input).toEqual({ [name]: '' })
  })
  it('retains null, false, zero, empty optional strings and Unicode character semantics', () => {
    const schema = tools.schema({ type: 'object', required: ['n', 'b', 'zero', 'text'], properties: {
      n: { type: 'null' }, b: { type: 'boolean' }, zero: { type: 'integer', minimum: 0 },
      text: { type: 'string', minLength: 1, maxLength: 1 }, empty: { type: 'string', maxLength: 0 },
    } })
    const input = { n: null, b: false, zero: 0, text: '😀', empty: '' }
    expect(tools.validate(schema, input)).toEqual(input)
  })
})

describe('actual serialized controller and DOM feedback, not native-browser acceptance', () => {
  const fixture = (schema: unknown, input: unknown) => {
    const dom = new JSDOM(inputControlsHtml, { runScripts: 'outside-only' })
    dom.window.TextEncoder = TextEncoder
    const json = dom.window.document.getElementById('live-input') as HTMLTextAreaElement
    json.value = JSON.stringify(input)
    const edited = vi.fn()
    Object.assign(dom.window, { inputEdited: edited })
    const controller = dom.window.eval(`(${liveInputControls.toString()})(${JSON.stringify(schema)}, (${schemaInputTools.toString()})(), window.inputEdited)`) as ReturnType<typeof liveInputControls>
    const notice = dom.window.document.getElementById('input-message')!
    return { dom, json, controller, notice, edited }
  }
  it('shows a local correction, preserves the invalid draft/previous JSON and clears it after explicit correction', () => {
    const f = fixture({ type: 'object', properties: { message: { type: 'string', minLength: 1 } }, required: ['message'] }, { message: 'hello' })
    try {
      const field = f.dom.window.document.querySelector<HTMLTextAreaElement>('#input-fields textarea:not([id$="-extra"])')!
      const previous = f.json.value
      field.value = ''
      expect(() => f.controller.read()).toThrow('message: Enter at least 1 character.')
      expect(f.notice.textContent).toContain('message: Enter at least 1 character.')
      expect(f.json.value).toBe(previous); expect(field.value).toBe('')
      field.value = 'fixed'
      expect(f.controller.read()).toEqual({ message: 'fixed' })
      expect(f.notice.textContent).toBe('Input is valid.')
      expect(JSON.parse(f.json.value)).toEqual({ message: 'fixed' })
    } finally { f.dom.window.close() }
  })
  it('renders hostile schema field names as text, not markup, in the correction region', () => {
    const name = '<img src=x onerror=alert(1)>', f = fixture({ type: 'object', properties: { [name]: { type: 'string' } }, required: [name] }, {})
    try {
      expect(() => f.controller.read()).toThrow('Include this required field.')
      expect(f.notice.textContent).toContain(name)
      expect(f.dom.window.document.querySelector('img')).toBeNull()
    } finally { f.dom.window.close() }
  })
  it('reports malformed JSON without echoing it or rewriting the JSON fallback', () => {
    const f = fixture({ type: 'string', pattern: 'unsupported' }, 'sample')
    try {
      expect(f.controller.mode()).toBe('json')
      f.json.value = 'PRIVATE_INVALID_JSON'
      expect(() => f.controller.read()).toThrow('Enter valid JSON.')
      expect(f.notice.textContent).toContain('Enter valid JSON.')
      expect(f.notice.textContent).not.toContain('PRIVATE_INVALID_JSON')
      expect(f.json.value).toBe('PRIVATE_INVALID_JSON')
    } finally { f.dom.window.close() }
  })
  it.each([
    [{ type: 'number', minimum: 0 }, -1, 'Enter a number of at least 0.'],
    [{ type: 'integer' }, 'PRIVATE_BAD_INTEGER', 'Enter a whole number.'],
    [{ type: 'boolean' }, 'PRIVATE_BAD_BOOLEAN', 'Choose true or false.'],
    [{ type: 'string', enum: ['first', 'second'] }, 'PRIVATE_UNKNOWN_CHOICE', 'Choose one of the listed values.'],
    [{ type: 'object', properties: { code: { type: 'string' } }, required: ['code'] }, {}, 'Include this required field.'],
    [{ type: 'object', properties: {}, additionalProperties: false }, { PRIVATE_EXTRA: 'PRIVATE_VALUE' }, 'Remove additional fields'],
    [{ type: 'array', items: { type: 'string' }, maxItems: 3 }, Array.from({ length: 33 }, () => 'PRIVATE_ROW'), 'Use no more than 3 items.'],
    [{ type: 'array', items: { type: 'object', properties: { amount: { type: 'number', minimum: 0 } }, required: ['amount'] } },
      [{ amount: 0 }, { amount: -1 }], 'Input → Item 2 → amount: Enter a number of at least 0.'],
  ])('validates JSON-mode input against supported runtime schema without rewriting it: %j', (schema, input, correction) => {
    const f = fixture(schema, input)
    try {
      f.dom.window.document.getElementById('input-use-json')!.click()
      expect(f.controller.mode()).toBe('json')
      const exact = '\n ' + JSON.stringify(input, null, 3) + '\n'
      f.json.value = exact
      const compiled = compileValueSchema(schema, DEFAULT_COMPILER_LIMITS.schema)
      expect(() => validateWorkflowValue(compiled, input, DEFAULT_COMPILER_LIMITS.binding.data)).toThrow()
      expect(() => f.controller.read()).toThrow(correction)
      expect(f.notice.textContent).toContain(correction)
      expect(f.notice.textContent).not.toContain('PRIVATE_')
      expect(f.json.value).toBe(exact)
      expect(f.controller.mode()).toBe('json')
    } finally { f.dom.window.close() }
  })
  it('accepts a valid array beyond the field-editor limit without truncating or normalizing JSON', () => {
    const input = Array.from({ length: 33 }, (_, i) => i), schema = { type: 'array', items: { type: 'integer' }, maxItems: 64 }
    const f = fixture(schema, input)
    try {
      expect(f.controller.mode()).toBe('json')
      const exact = '\n ' + JSON.stringify(input, null, 3) + '\n'; f.json.value = exact
      expect(f.controller.read()).toEqual(input)
      expect(f.json.value).toBe(exact)
      expect(f.notice.textContent).toBe('Input is valid.')
      const compiled = compileValueSchema(schema, DEFAULT_COMPILER_LIMITS.schema)
      expect(validateWorkflowValue(compiled, input, DEFAULT_COMPILER_LIMITS.binding.data)).toEqual(input)
    } finally { f.dom.window.close() }
  })
  it('retains runtime validation for a schema outside the field-editor subset', () => {
    const f = fixture({ type: 'string', pattern: '^allowed$' }, 'not allowed')
    try {
      expect(f.controller.mode()).toBe('json')
      expect(f.controller.read()).toBe('not allowed')
      expect(f.json.value).toBe('"not allowed"')
      expect(f.notice.textContent).not.toBe('Input is valid.')
    } finally { f.dom.window.close() }
  })
  it('invalidates an obsolete JSON correction on typing without checking, normalizing or submitting the new draft', () => {
    const f = fixture({ type: 'integer', enum: [0, 1] }, 0)
    try {
      expect(f.edited).not.toHaveBeenCalled()
      f.dom.window.document.getElementById('input-use-json')!.click()
      f.json.value = '2'; expect(() => f.controller.read()).toThrow('Choose one of the listed values.')
      f.edited.mockClear()
      const draft = '\n "still invalid and private"\n'; f.json.value = draft
      f.json.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
      expect(f.json.value).toBe(draft)
      expect(f.notice.textContent).toBe('Input changed. Choose Run workflow to check it; nothing was submitted.')
      expect(f.edited).toHaveBeenCalledOnce()
      expect(() => f.controller.read()).toThrow('Enter a whole number.')
      expect(f.json.value).toBe(draft)
    } finally { f.dom.window.close() }
  })
  it('clears an obsolete field correction when a select or inclusion checkbox changes without rereading the draft', () => {
    const f = fixture({ type: 'object', required: ['choice'], properties: { choice: { type: 'integer', enum: [0, 1] } } }, {})
    try {
      expect(() => f.controller.read()).toThrow('Include this required field.')
      const include = f.dom.window.document.querySelector<HTMLInputElement>('#input-fields input[type="checkbox"]')!
      include.checked = true; include.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }))
      expect(f.notice.textContent).toContain('Input changed.')
      expect(f.edited).toHaveBeenCalledOnce()
      const select = f.dom.window.document.querySelector<HTMLSelectElement>('#input-fields select')!
      select.value = '1'; select.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }))
      expect(f.edited).toHaveBeenCalledTimes(2)
      expect(f.json.value).toBe('{}')
      expect(f.controller.read()).toEqual({ choice: 1 })
    } finally { f.dom.window.close() }
  })
  it('notifies successful mode changes but not initialization, repeated mode selection or failed conversion', () => {
    const f = fixture({ type: 'integer' }, 0)
    try {
      const fields = f.dom.window.document.getElementById('input-use-fields')!, json = f.dom.window.document.getElementById('input-use-json')!
      expect(f.edited).not.toHaveBeenCalled(); fields.click(); expect(f.edited).not.toHaveBeenCalled()
      json.click(); expect(f.edited).toHaveBeenCalledOnce(); json.click(); expect(f.edited).toHaveBeenCalledOnce()
      f.json.value = 'PRIVATE_NOT_JSON'; fields.click()
      expect(f.controller.mode()).toBe('json'); expect(f.edited).toHaveBeenCalledOnce()
      expect(f.notice.textContent).toContain('Enter valid JSON.')
      f.json.value = '1'; fields.click(); expect(f.edited).toHaveBeenCalledTimes(2)
      expect(f.controller.mode()).toBe('fields'); expect(f.notice.textContent).not.toContain('Enter valid JSON.')
    } finally { f.dom.window.close() }
  })
  it('notifies an explicit successful array edit and retains the local-edit notice without validating or executing', () => {
    const f = fixture({ type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 3 }, [''])
    try {
      expect(() => f.controller.read()).toThrow('Enter at least 1 character.')
      const add = [...f.dom.window.document.querySelectorAll<HTMLButtonElement>('#input-fields button')].find(b => b.textContent === 'Add item')!
      add.click(); expect(f.edited).toHaveBeenCalledOnce()
      expect(f.notice.textContent).toContain('Array edited locally.')
      expect(f.json.value).toBe('[""]')
      expect(() => f.controller.read()).toThrow('Enter at least 1 character.')
    } finally { f.dom.window.close() }
  })
  it('keeps initial unsupported-schema guidance when JSON is edited, until a real read produces a separate correction', () => {
    const f = fixture({ type: 'string', pattern: '^allowed$' }, 'sample')
    try {
      const initial = f.notice.textContent
      f.json.value = '"not allowed"'; f.json.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
      expect(f.notice.textContent).toBe(initial); expect(f.edited).toHaveBeenCalledOnce()
      f.json.value = '{'; expect(() => f.controller.read()).toThrow('Enter valid JSON.')
      f.json.value = '"still not checked"'; f.json.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
      expect(f.notice.textContent).toContain('Input changed.'); expect(f.controller.read()).toBe('still not checked')
    } finally { f.dom.window.close() }
  })
})
