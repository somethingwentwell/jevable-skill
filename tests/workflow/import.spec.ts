import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { parse, stringify } from 'yaml'
import { compileWorkflowYaml, importWorkflow, WorkflowImportError, WorkflowCompileError } from '../../src/workflow/index.ts'
import type { ImportMapping } from '../../src/workflow/index.ts'

const limits = { maxSourceBytes: 100_000, maxDepth: 64, maxValues: 10_000, maxNodes: 100, maxEdges: 100 }
const compile = { source: limits, schema: { maxBytes: 10_000, maxDepth: 24, maxValues: 1000 },
  binding: { data: { maxBytes: 10_000, maxDepth: 24, maxValues: 1000 }, maxExpressions: 20,
    expression: { maxSourceBytes: 1024, maxNodes: 100, maxDepth: 24, maxResultBytes: 10_000 } } }
const fixture = (name: string) => readFile(new URL(`./fixtures/import/${name}`, import.meta.url), 'utf8')
const doc = (result: { yaml: string }) => parse(result.yaml) as Record<string, unknown> & { spec: Record<string, unknown> }
const summary = (mappings: readonly ImportMapping[]) => mappings.map(item => `${item.source} → ${item.target ?? '-'}: ${item.kind}/${item.reason}`)

describe('vendor workflow import', () => {
  it('converts n8n rules and routes into a runnable draft with an inferred input schema', async () => {
    const result = importWorkflow(await fixture('n8n-triage.json'), limits)
    expect(result).toMatchObject({ format: 'n8n', version: 'editor-json', title: 'Ticket triage', sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) as unknown })
    expect(summary(result.mappings)).toEqual([
      'When clicking Test workflow → When_clicking_Test_workflow: exact/mapped', 'Is urgent? → Is_urgent: exact/mapped',
      'Route by team → Route_by_team: exact/mapped'])
    await expect(result.yaml).toMatchFileSnapshot('./expected/import-n8n-triage.yaml')
    expect(() => compileWorkflowYaml(result.yaml, compile)).not.toThrow()
  })

  it('reports approximate and unsupported n8n nodes and keeps unsupported ones from running', async () => {
    const result = importWorkflow(await fixture('n8n-assistant.json'), limits)
    expect(summary(result.mappings)).toEqual([
      'Webhook → Webhook: approximate/trigger-mode', 'Write reply → Write_reply: approximate/model-route',
      'OpenAI Chat Model → -: approximate/model-route', 'Format → Format: approximate/code', 'Send email → Send_email: unsupported/node-type',
      'Log → -: unsupported/unreachable', 'Old filter → -: unsupported/unreachable', 'Schedule → -: unsupported/trigger-mode',
      'Python → -: unsupported/unreachable'])
    await expect(result.yaml).toMatchFileSnapshot('./expected/import-n8n-assistant.yaml')
    expect(() => compileWorkflowYaml(result.yaml, compile)).toThrow(WorkflowCompileError)
  })

  it('converts an n8n Loop Over Items into a For Each loop whose body reads the current item', async () => {
    const result = importWorkflow(await fixture('n8n-loop.json'), limits)
    expect(summary(result.mappings)).toEqual(['Start → Start: exact/mapped', 'Is long? → Is_long: exact/mapped',
      'Summarize → Summarize: approximate/model-route', 'Loop Over Items → Loop_Over_Items: approximate/loop', 'Report → Report: approximate/code'])
    await expect(result.yaml).toMatchFileSnapshot('./expected/import-n8n-loop.yaml')
    const spec = doc(result).spec as { inputSchema: unknown; nodes: Record<string, { config: Record<string, unknown> }> }
    expect(spec.inputSchema).toEqual({ type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'object',
      required: ['words', 'text'], properties: { words: { type: 'number' }, text: { type: 'string' } } } } } })
    expect(spec.nodes.Loop_Over_Items!.config).toMatchObject({ mode: 'forEach', items: '${{ inputs.items }}', body: { entry: 'Is_long',
      edges: [{ from: 'Is_long', to: 'Summarize', port: 'true' }], exits: [{ from: 'Is_long', port: 'false', result: '${{ loop.item }}' },
        { from: 'Summarize', result: '${{ nodes.Summarize.output }}' }] } })
    // The skipped item and the summary have different types, which the user resolves while reviewing the draft.
    expect(() => compileWorkflowYaml(result.yaml, compile)).toThrow(WorkflowCompileError)
    const node = (name: string, type: string, parameters: Record<string, unknown> = {}, typeVersion = type.endsWith('splitInBatches') ? 3 : 2) =>
      ({ name, type, typeVersion, parameters })
    const link = (...names: string[]) => [names.map(name => ({ node: name, type: 'main', index: 0 }))]
    const tagged = importWorkflow(JSON.stringify({ name: 'Tag items', nodes: [node('Go', 'n8n-nodes-base.manualTrigger', {}, 1),
      node('Each', 'n8n-nodes-base.splitInBatches'), node('Tag', 'n8n-nodes-base.code', { jsCode: 'return { ...$json, seen: true }' })],
    connections: { Tag: { main: link('Each') }, Go: { main: link('Each') }, Each: { main: [[], [{ node: 'Tag', type: 'main', index: 0 }]] } } }), limits)
    expect(doc(tagged).spec).toMatchObject({ inputSchema: { properties: { items: { type: 'array', items: { type: 'object' } } } },
      nodes: { Each: { config: { body: { nodes: { Tag: { config: { input: '${{ loop.item }}' } } } } } } } })
    expect(() => compileWorkflowYaml(tagged.yaml, compile)).not.toThrow()
  })

  it('reads an n8n loop list from the step before it and translates routing steps inside the loop', () => {
    const node = (name: string, type: string, parameters: Record<string, unknown> = {}, typeVersion = type.endsWith('splitInBatches') ? 3 : 2) =>
      ({ name, type, typeVersion, parameters })
    const target = (name: string) => ({ node: name, type: 'main', index: 0 })
    const route = { rules: { values: [{ conditions: { conditions: [{ leftValue: '={{ $json.kind }}', rightValue: 'a', operator: { operation: 'equals' } }] } }] } }
    const result = importWorkflow(JSON.stringify({ name: 'Fetched', nodes: [node('Go', 'n8n-nodes-base.manualTrigger', {}, 1),
      node('Fetch', 'n8n-nodes-base.code', { jsCode: 'return []' }), node('Each', 'n8n-nodes-base.splitInBatches'),
      node('Route', 'n8n-nodes-base.switch', route, 3), node('Mark', 'n8n-nodes-base.code', { jsCode: 'return $json' }),
      node('Skip', 'n8n-nodes-base.code', { jsCode: 'return $json' }), node('Post', 'n8n-nodes-base.code', { jsCode: 'return $json' }),
      node('Model', '@n8n/n8n-nodes-langchain.lmChatOpenAi', {}, 1)],
    connections: { Model: { ai_languageModel: [[target('Mark')]] }, Go: { main: [[target('Fetch')]] }, Fetch: { main: [[target('Each')], null] },
      Each: { main: [[], [target('Route')]] }, Route: { main: [[target('Mark'), target('Skip')], [target('Each')]] },
      Mark: { main: [[target('Each'), target('Missing'), target('Post')], null] } } }), limits)
    const loop = (doc(result).spec as { nodes: Record<string, { config: Record<string, unknown> }> }).nodes.Each!.config
    expect(loop).toMatchObject({ items: '${{ nodes.Fetch.output }}', body: { entry: 'Route',
      edges: [{ from: 'Route', to: 'Mark', port: 'case1' }, { from: 'Mark', to: 'Post' }],
      exits: [{ from: 'Route', port: 'default', result: '${{ loop.item }}' }, { from: 'Skip', result: '${{ nodes.Skip.output }}' },
        { from: 'Post', result: '${{ nodes.Post.output }}' }] } })
    expect(JSON.stringify(loop)).toContain('loop.item.kind')
    expect(doc(result).spec.inputSchema).toEqual({ type: 'object' })
    const orphan = importWorkflow(JSON.stringify({ name: 'Orphan', nodes: [node('Each', 'n8n-nodes-base.splitInBatches'),
      node('Tag', 'n8n-nodes-base.code', { jsCode: 'return $json' })], connections: { Each: { main: [[], [target('Tag')]] } } }), limits)
    expect(doc(orphan).spec.nodes).toMatchObject({ Each: { config: { items: '${{ inputs.items }}' } } })
  })

  it.each([
    ['a batch size above one', { batchSize: 5 }, { Each: { main: [[], [{ node: 'Work', type: 'main', index: 0 }]] } }, 'unsupported/loop'],
    ['no loop output', {}, { Each: { main: [[{ node: 'Work', type: 'main', index: 0 }]] } }, 'unsupported/loop'],
    ['two loop outputs', {}, { Each: { main: [[], [{ node: 'Work', type: 'main', index: 0 }, { node: 'Inner', type: 'main', index: 0 }]] } },
      'unsupported/loop'],
    ['a body step reached from outside the loop', {}, { Each: { main: [[], [{ node: 'Work', type: 'main', index: 0 }]] },
      Go: { main: [[{ node: 'Each', type: 'main', index: 0 }, { node: 'Work', type: 'main', index: 0 }]] } }, 'unsupported/loop'],
    ['a nested loop', {}, { Each: { main: [[], [{ node: 'Inner', type: 'main', index: 0 }]] } }, 'unsupported/loop'],
  ])('reports an n8n loop with %s as unsupported', (_name, parameters, connections, mapping) => {
    const nodes = [{ name: 'Go', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
      { name: 'Each', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, parameters },
      { name: 'Work', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode: 'return $json' } },
      { name: 'Inner', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, parameters: {} }]
    const result = importWorkflow(JSON.stringify({ name: 'Bad loop', nodes, connections: { Go: { main: [[{ node: 'Each', type: 'main', index: 0 }]] },
      ...connections } }), limits)
    expect(summary(result.mappings).find(line => line.startsWith('Each'))).toBe(`Each → Each: ${mapping}`)
    const legacy = importWorkflow(JSON.stringify({ name: 'Old loop', nodes: [{ ...nodes[1], typeVersion: 1 }] }), limits)
    expect(summary(legacy.mappings)).toContain('Each → Each: unsupported/node-type')
  })

  it.each([
    ['a Dify secret environment value', { version: '0.1.5', app: { name: 'x' }, workflow: { environment_variables: [
      { name: 'API_KEY', value_type: 'secret', value: 'not-for-storage' }], graph: { nodes: [], edges: [] } } }],
    ['a credential field', { name: 'x', nodes: [{ name: 'Call', type: 'n8n-nodes-base.httpRequest', parameters: { password: 'hunter2' } }] }],
    ['a bearer token', { name: 'x', nodes: [{ name: 'Call', type: 'n8n-nodes-base.httpRequest',
      parameters: { headers: [{ name: 'Authorization', value: 'Bearer abcdefghijklmnop' }] } }] }],
    ['URL credentials', { name: 'x', nodes: [{ name: 'Call', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://me:pw@api.example' } }] }],
  ])('refuses an upload that carries %s instead of keeping it', (_name, upload) => {
    expect(() => importWorkflow(JSON.stringify(upload), limits)).toThrow(expect.objectContaining({ code: 'secret-values' }) as Error)
  })

  it('accepts a Dify export whose secret variables were left empty', () => {
    const upload = { version: '0.1.5', app: { name: 'Empty secrets' }, workflow: { environment_variables: [
      { name: 'API_KEY', value_type: 'secret', value: '' }, { name: 'REGION', value_type: 'string', value: 'eu' }],
    graph: { nodes: [{ id: 's', data: { type: 'start', title: 'Start' } }], edges: [] } } }
    expect(importWorkflow(stringify(upload), limits).format).toBe('dify')
  })

  it('converts a Dify workflow with typed inputs, a rule, an LLM step and outputs', async () => {
    const result = importWorkflow(await fixture('dify-support.yml'), limits)
    expect(result).toMatchObject({ format: 'dify', version: '0.1.5', title: 'Support answer' })
    expect(summary(result.mappings)).toEqual(['Start → Start: exact/mapped', 'Gold customer → Gold_customer: exact/mapped',
      'Draft answer → Draft_answer: approximate/model-route', 'Answer → Answer: exact/mapped', 'Standard reply → Standard_reply: exact/mapped'])
    await expect(result.yaml).toMatchFileSnapshot('./expected/import-dify-support.yaml')
    expect(() => compileWorkflowYaml(result.yaml, compile)).not.toThrow()
  })

  it('marks Dify nodes that cannot be translated and adds a start when a graph has none', async () => {
    const mixed = importWorkflow(await fixture('dify-mixed.yml'), limits)
    expect(mixed.title).toBe('Imported Dify workflow')
    expect(summary(mixed.mappings)).toEqual(['s → s: approximate/node-type', 'Many cases → -: unsupported/unreachable',
      'Shape → Shape: approximate/code', 'Python step → -: unsupported/unreachable', 'Call API → -: unsupported/unreachable',
      'Guess → Guess: approximate/expression', 'Legacy → -: unsupported/unreachable', 'Done → Done: approximate/expression'])
    await expect(mixed.yaml).toMatchFileSnapshot('./expected/import-dify-mixed.yaml')
    const headless = stringify({ version: '0.2.1', app: { name: 'No start' }, workflow: { graph: {
      nodes: [{ id: 'a', data: { type: 'if-else', title: 'Check', cases: [{ case_id: 'x', logical_operator: 'or',
        conditions: [{ variable_selector: ['b', 'text'], comparison_operator: 'not empty' }, { variable_selector: ['b', 'n'], comparison_operator: '<', value: 'x' }] }] } },
      { id: 'b', data: { type: 'llm', title: 'Model' } }, { id: 'c', data: { type: 'code', code_language: 'python3' } }], edges: [
        { source: 'b', target: 'a' }, { source: 'a', target: 'c', sourceHandle: 'true' }] } } })
    const converted = importWorkflow(headless, limits)
    expect(summary(converted.mappings)).toEqual(['Check → Check: exact/mapped', 'Model → Model: approximate/model-route',
      'c → c: unsupported/language', 'Start → Start: approximate/trigger-mode'])
    expect(converted.yaml).toContain('condition: ${{ exists(nodes.Model.output) || nodes.Model.output.n < "x" }}')
  })

  it('converts a Dify iteration into a For Each loop whose body reads the loop item and index', async () => {
    const result = importWorkflow(await fixture('dify-iteration.yml'), limits)
    expect(summary(result.mappings)).toEqual(['Start → Start: exact/mapped', 'Split topics → Split_topics: approximate/code',
      'Long topic → Long_topic: exact/mapped', 'Write summary → Write_summary: approximate/model-route', 'tidy → tidy: approximate/code',
      'Notify → Notify: unsupported/node-type', 'Each topic → Each_topic: approximate/loop',
      'Summaries → Summaries: exact/mapped', 'Broken loop → -: unsupported/unreachable'])
    const nodes = doc(result).spec.nodes as Record<string, { type: string; config: Record<string, unknown> }>
    expect(nodes.Each_topic).toMatchObject({ type: 'loop', config: { mode: 'forEach', items: '${{ nodes.Split_topics.output.topics }}',
      maxIterations: 100, timeoutSeconds: 600, body: { entry: 'Long_topic', edges: [{ from: 'Long_topic', to: 'Write_summary', port: 'true' },
        { from: 'Write_summary', to: 'tidy' }],
      exits: [{ from: 'Long_topic', port: 'false', result: '${{ nodes.Write_summary.output }}' },
        { from: 'tidy', result: '${{ nodes.Write_summary.output }}' }, { from: 'Notify', result: '${{ nodes.Write_summary.output }}' }] } } })
    const body = (nodes.Each_topic!.config.body as { nodes: Record<string, { config: Record<string, string> }> }).nodes
    expect(body.Long_topic!.config.condition).toBe('${{ loop.index > 2 }}')
    expect(body.Write_summary!.config.prompt).toBe('Summarize ${{ loop.item }} (topic ${{ loop.index }})')
    expect(body.tidy!.config.input).toEqual({ s: '${{ nodes.Each_topic.output.first }}' })
    expect(nodes.Summaries!.config.value).toEqual({ summaries: '${{ nodes.Each_topic.output.results }}' })
    expect(result.yaml).toContain('done')
  })

  it('reports an iteration without a readable list, first step or output as unsupported', () => {
    const graph = { nodes: [{ id: 's', data: { type: 'start' } }, { id: 'i', data: { type: 'iteration', title: 'Loop', iterator_selector: ['s', 'x'] } }],
      edges: [{ source: 's', target: 'i' }] }
    const result = importWorkflow(stringify({ version: '0.1.0', app: { name: 'Loop' }, workflow: { graph } }), limits)
    expect(summary(result.mappings)).toContain('Loop → Loop: unsupported/loop')
  })

  it('refuses unknown formats, unsupported Dify versions, oversized uploads and drafts beyond the source limits', async () => {
    const reason = (run: () => unknown) => { try { run() } catch (error) { return error instanceof WorkflowImportError ? error.code : 'other' } return 'none' }
    expect(reason(() => importWorkflow('{"nodes": []}', limits))).toBe('unknown-format')
    expect(reason(() => importWorkflow('key: [unclosed', limits))).toBe('unknown-format')
    expect(reason(() => importWorkflow('{"a": 1, "a": 2}', limits))).toBe('unknown-format')
    const dify = await fixture('dify-support.yml'), triage = await fixture('n8n-triage.json')
    expect(reason(() => importWorkflow(dify.replace('version: 0.1.5', 'version: 1.0.0'), limits))).toBe('unsupported-version')
    expect(reason(() => importWorkflow('x'.repeat(200), { ...limits, maxSourceBytes: 100 }))).toBe('too-large')
    expect(reason(() => importWorkflow(triage, { ...limits, maxNodes: 2 }))).toBe('invalid-draft')
  })

  it('refuses uploads that use YAML aliases or nest far beyond any workflow, without echoing them', () => {
    const reason = (text: string) => { try { importWorkflow(text, limits) } catch (error) { return error instanceof WorkflowImportError ? error.code : 'other' } return 'none' }
    expect(reason('app: &a {mode: workflow}\nkind: app\nversion: 0.1.5\nother: *a\nworkflow: {graph: {nodes: [], edges: []}}\n')).toBe('unknown-format')
    for (const depth of [2000, 200_000]) {
      const nested = `${'['.repeat(depth)}${']'.repeat(depth)}`
      expect(reason(`{"app":{"mode":"workflow"},"kind":"app","version":"0.1.5","workflow":{"graph":{"nodes":[${nested}],"edges":[]}}}`))
        .toBe(depth * 2 + 100 > limits.maxSourceBytes ? 'too-large' : 'unknown-format')
    }
  })

  it('converts the first Zap with a filter Rule, an AI step and placeholders for other apps', async () => {
    const result = importWorkflow(await fixture('zapier-support.json'), limits)
    expect(result).toMatchObject({ format: 'zapier', version: '1.0.0', title: 'Refund replies' })
    expect(result.mappings.map(({ source, kind, reason }) => [source, kind, reason])).toEqual([
      ['New email', 'approximate', 'trigger-mode'], ['Only refunds', 'exact', 'mapped'], ['Draft reply', 'approximate', 'expression'],
      ['Notify team', 'unsupported', 'unreachable'], ['Send reply', 'unsupported', 'node-type']])
    type Nodes = Record<string, { type: string; config: Record<string, unknown> }>
    const document = parse(result.yaml) as { spec: { inputSchema: unknown; nodes: Nodes } }
    expect(document.spec.nodes.Only_refunds!.config.condition).toBe('${{ inputs.subject == "Refund" }}')
    expect(document.spec.nodes.Draft_reply!.config).toMatchObject({ model: 'gpt-4o-mini', provider: 'openai',
      prompt: 'Draft a short reply to ${{ inputs.body_plain }} from ${{ inputs.from.email }} ({{1__date|formatted}}).' })
    expect(document.spec.inputSchema).toMatchObject({ type: 'object', required: ['subject', 'body_plain', 'from'] })
    expect(() => compileWorkflowYaml(result.yaml, compile)).toThrow(WorkflowCompileError)
  })

  it('converts a Make scenario with a filter Rule, an AI step, the first router route and placeholders', async () => {
    const result = importWorkflow(await fixture('make-support.json'), limits)
    expect(result).toMatchObject({ format: 'make', version: '1', title: 'Ticket summaries' })
    expect(result.mappings.map(({ source, kind, reason }) => [source, kind, reason])).toEqual([
      ['gateway:CustomWebHook 1', 'approximate', 'trigger-mode'], ['Open tickets', 'exact', 'mapped'],
      ['openai-gpt-3:CreateCompletion 2', 'approximate', 'model-route'], ['email:ActionSendEmail 5', 'unsupported', 'unreachable'],
      ['builtin:BasicRouter 3', 'approximate', 'operator'], ['slack:CreateMessage 4', 'unsupported', 'node-type'],
      ['Big', 'unsupported', 'operator'], ['code:ExecuteCode 6', 'unsupported', 'code']])
    type Nodes = Record<string, { type: string; config: Record<string, unknown> }>
    const document = parse(result.yaml) as { spec: { nodes: Nodes; edges: unknown[] } }
    expect(document.spec.nodes.Open_tickets!.config.condition).toBe('${{ inputs.status == "open" }}')
    expect(document.spec.nodes.openai_gpt_3_CreateCompletion_2!.config).toMatchObject({ model: 'gpt-4o', provider: 'openai',
      prompt: 'Summarize ${{ inputs.message }} for ${{ inputs.customer.name }}.' })
    expect(document.spec.edges).toContainEqual({ from: 'Open_tickets', port: 'true', to: 'openai_gpt_3_CreateCompletion_2' })
  })

  it('converts a Power Automate package flow with an If Rule, an AI step, an Output and placeholders for connectors', async () => {
    const result = importWorkflow(await fixture('power-automate-tickets.json'), limits)
    expect(result).toMatchObject({ format: 'power-automate', version: '2016-06-01', title: 'Ticket replies' })
    expect(summary(result.mappings)).toEqual(['manual → manual: exact/mapped', 'Check priority → Check_priority: exact/mapped',
      'Draft reply → Draft_reply: approximate/model-route', 'Reply → Reply: exact/mapped', 'Send an email → Send_an_email: unsupported/node-type',
      'Notify on failure → -: unsupported/unreachable'])
    await expect(result.yaml).toMatchFileSnapshot('./expected/import-power-automate-tickets.yaml')
    type Nodes = Record<string, { type: string; config: Record<string, unknown> }>
    const document = parse(result.yaml) as { spec: { inputSchema: unknown; nodes: Nodes; edges: unknown[] } }
    expect(document.spec.nodes.Check_priority!.config.condition).toBe('${{ inputs.text_1 == "high" }}')
    expect(document.spec.nodes.Draft_reply!.config).toMatchObject({ provider: 'openai', model: 'gpt-4o',
      prompt: 'Write an urgent reply to: ${{ inputs.text }}' })
    expect(document.spec.nodes.Reply).toMatchObject({ type: 'output', config: { value: '${{ nodes.Draft_reply.output }}' } })
    expect(document.spec.edges).toEqual(expect.arrayContaining([{ from: 'Check_priority', port: 'true', to: 'Draft_reply' },
      { from: 'Draft_reply', to: 'Reply' }, { from: 'Check_priority', port: 'false', to: 'Send_an_email' }]))
    expect(document.spec.inputSchema).toEqual({ type: 'object', required: ['text_1', 'text'],
      properties: { text_1: { type: 'string' }, text: { type: 'string' } } })
    expect(() => compileWorkflowYaml(result.yaml, compile)).toThrow(WorkflowCompileError)
  })

  it('runs a converted Power Automate button flow and reads bare definitions and solution exports', () => {
    const definition = { $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
      triggers: { manual: { type: 'Request', kind: 'Button' } },
      actions: { Is_open: { type: 'If', runAfter: {}, expression: { equals: ["@triggerBody()?['status']", 'open'] },
        actions: { Open: { type: 'Compose', runAfter: {}, inputs: 'Ticket @{triggerBody()?[\'id\']} is open' } },
        else: { actions: { Closed: { type: 'Response', kind: 'Http', runAfter: {}, inputs: { statusCode: 200, body: "@triggerBody()?['id']" } } } } } } }
    const bare = importWorkflow(JSON.stringify(definition), limits)
    expect(bare.title).toBe('Imported Power Automate flow')
    expect(summary(bare.mappings)).toEqual(['manual → manual: exact/mapped', 'Is open → Is_open: exact/mapped', 'Open → Open: exact/mapped',
      'Closed → Closed: approximate/mapped'])
    const compiled = compileWorkflowYaml(bare.yaml, compile)
    expect(compiled.nodes.map(node => node.plan.kind)).toEqual(['trigger', 'ifElse', 'output', 'output'])
    expect((parse(bare.yaml) as { spec: { nodes: Record<string, { config: unknown }> } }).spec.nodes.Open!.config)
      .toEqual({ value: 'Ticket ${{ inputs.id }} is open' })
    const solution = importWorkflow(JSON.stringify({ properties: { connectionReferences: {}, definition }, schemaVersion: '1.0.0.0' }), limits)
    expect(doc(solution).spec).toEqual(doc(bare).spec)
    const reason = (text: string) => { try { importWorkflow(text, limits) } catch (error) { return error instanceof WorkflowImportError ? error.code : 'other' } return 'none' }
    expect(reason(JSON.stringify({ ...definition, $schema: definition.$schema.replace('2016-06-01', '2015-08-01-preview') }))).toBe('unsupported-version')
    expect(reason(JSON.stringify({ ...definition, $schema: 'https://example.com/other.json' }))).toBe('unknown-format')
    expect(reason(JSON.stringify({ ...definition, actions: { Broken: 'not an action' } }))).toBe('unknown-format')
  })

  it('handles edge cases of Power Automate actions: switches, scopes, loops, parallel and failure paths, references', () => {
    const $schema = 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json'
    const convert = (triggers: Record<string, unknown>, actions: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const result = importWorkflow(JSON.stringify({ $schema, triggers, actions, ...extra }), limits)
      type Nodes = Record<string, { type: string; config: Record<string, unknown> }>
      return { result, spec: doc(result).spec as { nodes: Nodes; edges: unknown[] } }
    }
    const http = { When_a_request_arrives: { type: 'Request', kind: 'Http' } }
    const team = "@triggerOutputs()?['body/team']"
    const routed = convert(http, {
      Route: { type: 'Switch', runAfter: {}, expression: team,
        cases: { Sales: { case: 'sales', actions: { Sales_note: { type: 'Compose', runAfter: {}, inputs: '@@sales' } } },
          Support: { case: 2, actions: {} } },
        default: { actions: { Other: { type: 'Compose', runAfter: {}, inputs: { team: '@{triggerBody()?[\'team\']}' } } } } },
      Tidy: { type: 'Scope', runAfter: { Route: ['Succeeded'] }, actions: {
        Summarize: { type: 'ApiConnection', runAfter: {}, inputs: { host: { operationId: 'aibuilderpredict_customprompt' } } },
        Each: { type: 'Foreach', runAfter: { Summarize: ['Succeeded'] }, foreach: '@body(\'Summarize\')', actions: { Inner: { type: 'Http', runAfter: {} } } },
        Retry: { type: 'Until', runAfter: { Summarize: ['Succeeded'] }, actions: {} } } },
      Script: { type: 'JavaScriptCode', runAfter: { Tidy: ['Succeeded'] } },
      Late: { type: 'Compose', runAfter: { Missing: ['Succeeded'] }, inputs: 'never' } },
    { displayName: ' Routing ' })
    expect(routed.result.title).toBe('Routing')
    expect(summary(routed.result.mappings)).toEqual(['When a request arrives → When_a_request_arrives: approximate/trigger-mode',
      'Route → Route: exact/mapped', 'Sales note → Sales_note: unsupported/node-type', 'Other → Other: unsupported/node-type', 'Tidy → -: exact/mapped',
      'Summarize → Summarize: approximate/model-route', 'Each → Each: unsupported/loop', 'Inner → -: unsupported/loop',
      'Retry → -: unsupported/unreachable', 'Script → Script: unsupported/code', 'Late → -: unsupported/unreachable'])
    expect(routed.spec.nodes.Route!.config).toEqual({ mode: 'switch', value: '${{ inputs.team }}',
      cases: [{ port: 'case1', value: 'sales' }, { port: 'case2', value: 2 }] })
    expect(routed.spec.nodes.Summarize!.config).toMatchObject({ provider: 'azure-openai', prompt: 'Describe the task.' })
    expect(routed.spec.edges).toEqual(expect.arrayContaining([{ from: 'Route', port: 'case1', to: 'Sales_note' },
      { from: 'Route', port: 'case2', to: 'Summarize' }, { from: 'Summarize', to: 'Each' }, { from: 'Each', to: 'Script' }]))
    const fallback = (expression: unknown, cases?: unknown) => convert({ manual: { type: 'Request', kind: 'Button' }, Every_day: { type: 'Recurrence' } }, {
      Check: { type: 'If', runAfter: {}, expression, actions: { Yes: { type: 'Compose', runAfter: {}, inputs: "@concat('a', 'b')" },
        Then: { type: 'Compose', runAfter: { Yes: ['Succeeded'] } } }, else: { actions: { No: { type: 'Compose', runAfter: {}, inputs: 'x' } } } },
      Pick: { type: 'Switch', runAfter: { Check: ['Succeeded'] }, expression: "@triggerBody()?['kind']", cases,
        default: { actions: { Loose: { type: 'Compose', runAfter: {}, inputs: 'y' } } } } })
    const unsupported = fallback({ or: [{ equals: ["@triggerBody()?['a']", 1] }, { equals: ["@triggerBody()?['b']", 2] }] },
      { One: { case: { nested: true }, actions: { First: { type: 'Compose', runAfter: {} } } } })
    expect(summary(unsupported.result.mappings)).toEqual(['manual → manual: exact/mapped', 'Every day → -: unsupported/trigger-mode',
      'Check → Check: unsupported/operator', 'Yes → Yes: unsupported/node-type', 'Then → Then: unsupported/node-type', 'No → -: unsupported/unreachable',
      'Pick → Pick: unsupported/operator', 'First → First: approximate/expression', 'Loose → -: unsupported/unreachable'])
    expect(unsupported.spec.nodes.First!.config.value).toBe('')
    const conditions = [[{ not: { equals: ["@triggerBody()?['a']", 'x'] } }, '${{ inputs.a != "x" }}'],
      [{ and: [{ greater: ["@triggerBody()?['n']", '5'] }] }, '${{ inputs.n > 5 }}'], [{ lessOrEquals: ["@triggerBody()?['n']", 'many'] }, undefined],
      [{ equals: ["@triggerBody()?['a']", "@triggerBody()?['b']"] }, undefined], [{ equals: ["@triggerBody()?['a']", 'x', 'y'] }, undefined],
      [{ equals: ["@triggerBody()?['a']", { x: 1 }] }, undefined], [{ equals: ["@body('Other')", 'x'] }, undefined],
      [{ startsWith: ["@triggerBody()?['a']", 'x'] }, undefined], [{ not: { contains: ['a', 'b'] } }, undefined], [{ equals: 'x' }, undefined],
      ['@true', undefined], [{}, undefined], [{ equals: ["@triggerOutputs()?['headers']?['x']", 'x'] }, undefined]] as const
    for (const [expression, condition] of conditions) {
      expect(fallback(expression, {}).spec.nodes.Check!.config.condition).toBe(condition)
    }
    expect(fallback({ equals: ["@triggerBody()?['a']", 'x'] }, { A: { case: "@triggerBody()?['b']" } }).spec.nodes.Pick!.type).toBe('custom')
    expect(fallback({ equals: ["@triggerBody()?['a']", 'x'] }, { A: {} }).spec.nodes.Pick!.type).toBe('custom')
    const empty = convert({}, { Parallel_a: { type: 'Compose', runAfter: {}, inputs: '@@sales' }, Parallel_b: { type: 'Compose', runAfter: {}, inputs: 'b' } })
    expect(summary(empty.result.mappings)).toEqual(['Parallel a → Parallel_a: exact/mapped', 'Parallel b → -: unsupported/unreachable',
      'Start → Start: approximate/trigger-mode'])
    expect(empty.spec.nodes.Parallel_a!.config.value).toBe('@sales')
    for (const [inputs, value, kind] of [[{ team: "@{triggerBody()?['team']}" }, JSON.stringify({ team: "@{triggerBody()?['team']}" }), 'approximate'],
      [{ team: 'sales' }, JSON.stringify({ team: 'sales' }), 'exact'], ["@concat('a', 'b')", "@concat('a', 'b')", 'approximate'],
      ["@body('Nothing')", "@body('Nothing')", 'approximate']] as const) {
      const structured = convert(http, { Structured: { type: 'Compose', runAfter: {}, inputs } })
      expect([structured.spec.nodes.Structured!.config.value, structured.result.mappings[1]!.kind]).toEqual([value, kind])
    }
    const bare = convert({ Typeless: { kind: 'Custom' }, Second: {} }, { Bare_if: { type: 'If', runAfter: {}, expression: {} },
      Bare_switch: { type: 'Switch', runAfter: { Bare_if: ['Succeeded'] } }, Bare_scope: { type: 'Scope', runAfter: { Bare_switch: ['Succeeded'] } } })
    expect(bare.result.mappings.map(({ source, sourceType, kind }) => [source, sourceType, kind])).toEqual([['Typeless', 'unknown/Custom', 'approximate'],
      ['Second', 'unknown', 'unsupported'], ['Bare if', 'If', 'unsupported'], ['Bare switch', 'Switch', 'unsupported'], ['Bare scope', 'Scope', 'exact']])
    const reason = (text: string) => { try { importWorkflow(text, limits) } catch (error) { return error instanceof WorkflowImportError ? error.code : 'other' } return 'none' }
    expect(reason('[1]')).toBe('unknown-format')
    const unnamed = convert({ Unknown_trigger: {} }, { Step: {} })
    expect(summary(unnamed.result.mappings)).toEqual(['Unknown trigger → Unknown_trigger: approximate/trigger-mode', 'Step → Step: unsupported/node-type'])
    expect(unnamed.result.mappings.map(item => item.sourceType)).toEqual(['unknown', 'unknown'])
    const nested = convert(http, { Outer: { type: 'If', runAfter: {}, expression: {}, actions: { Deep: { type: 'Switch', runAfter: {}, cases: {
      C: { actions: { Leaf: { runAfter: {} } } } }, default: { actions: { Leaf_2: { runAfter: {} } } } } } } },
    { Ghost: { type: 'Compose', runAfter: { Outer: ['Failed'] } } })
    expect(nested.result.mappings.at(-1)).toMatchObject({ source: 'Leaf 2' })
    const failed = convert(http, { First: { type: 'Compose', runAfter: {}, inputs: 'a' },
      Recover: { type: 'If', runAfter: { First: ['Failed'] }, expression: {}, actions: { Undo: { type: 'Http', runAfter: {} } },
        else: { actions: { Log: { type: 'Switch', runAfter: {}, cases: { A: { actions: { Note: { runAfter: {} } } } }, default: { actions: { Note_2: {} } } } } } } })
    expect(summary(failed.result.mappings)).toEqual(['When a request arrives → When_a_request_arrives: approximate/trigger-mode',
      'First → First: exact/mapped', 'Recover → -: unsupported/unreachable', 'Undo → -: unsupported/unreachable', 'Log → -: unsupported/unreachable',
      'Note → -: unsupported/unreachable', 'Note 2 → -: unsupported/unreachable'])
  })

  it('runs a converted Zap of a trigger and a filter, and refuses unsupported vendor versions and shapes', async () => {
    const zap = JSON.parse(await fixture('zapier-support.json')) as { zaps: { nodes: Record<string, unknown> }[]; metadata: { version: string } }
    zap.zaps[0]!.nodes = { 1: zap.zaps[0]!.nodes['1'], 2: zap.zaps[0]!.nodes['2'] }
    const compiled = compileWorkflowYaml(importWorkflow(JSON.stringify(zap), limits).yaml, compile)
    expect(compiled.nodes.map(node => node.plan.kind)).toEqual(['trigger', 'ifElse', 'output', 'output'])
    const reason = (text: string) => { try { importWorkflow(text, limits) } catch (error) { return error instanceof WorkflowImportError ? error.code : 'other' } return 'none' }
    expect(reason(JSON.stringify({ ...zap, metadata: { version: '2.0.0' } }))).toBe('unsupported-version')
    expect(reason(JSON.stringify({ zaps: zap.zaps }))).toBe('unsupported-version')
    const make = JSON.parse(await fixture('make-support.json')) as { metadata: { version: number } }
    expect(reason(JSON.stringify({ ...make, metadata: { version: 2 } }))).toBe('unsupported-version')
    expect(reason(JSON.stringify({ zaps: [] }))).toBe('unknown-format')
    expect(reason(JSON.stringify({ flow: [{ module: 'x' }] }))).toBe('unknown-format')
  })

  it('handles edge cases of Zap steps: untranslatable filters, AI prompt sources, references and missing fields', () => {
    const node = (id: number, parent: number | null, extra: Record<string, unknown> = {}) => ({ id, parent_id: parent, ...extra })
    const filter = (id: number, criteria: unknown) => node(id, id - 1, { selected_api: 'FilterAPI', params: { filter_criteria: criteria } })
    const zap = { metadata: { version: '1.2.3' }, zaps: [{ nodes: Object.fromEntries([
      node(1, null), node(2, 1, { selected_api: 'FilterAPI' }), node(16, 1), filter(3, [[{ key: '{{1__n}}', match: 'num_gt', value: '5' }]]),
      filter(4, [[{ key: '{{1__n}}', match: 'contains', value: 'x' }]]),
      filter(5, [[{ key: '{{1__n}}', match: 'exact', value: 'a' }, { key: '{{1__n}}', match: 'exact', value: 'b' }]]),
      node(6, 5, { selected_api: 'AnthropicAPI', params: { prompt: 'Use {{1__0bad}} and {{5__x}}' } }),
      node(7, 6, { selected_api: 'GeminiAPI', title: '  ', params: { message: 'Improve {{6__text}}' } }),
      node(8, 7, { selected_api: 'CodeAPI' }), node(9, 8, { selected_api: 'OpenAIAPI' }),
      filter(10, [[{ key: '{{9__x}}', match: 'exact', value: 'y' }]]), filter(11, [[{ key: 'static', match: 'exact', value: 'a' }]]),
      filter(12, [[{ key: '{{1__n}}', match: 'num_lt', value: 'abc' }]]), filter(13, [[{ key: 5, match: 'exact' }]]),
      filter(14, [[{ key: '{{1__n}}', match: 'exact', value: 'a' }], [{ key: '{{1__n}}', match: 'exact', value: 'b' }]]),
      node(15, 14, { type_of: 'write' }),
    ].map(item => [String(item.id), item])) }] }
    const result = importWorkflow(JSON.stringify(zap), limits)
    expect(result.title).toBe('Imported Zap')
    expect(result.mappings.map(item => [item.source, item.kind, item.reason])).toEqual([
      ['Step 1', 'approximate', 'trigger-mode'], ['Step 16', 'unsupported', 'unreachable'], ['FilterAPI 2', 'unsupported', 'operator'], ['FilterAPI 3', 'exact', 'mapped'],
      ['FilterAPI 4', 'unsupported', 'operator'], ['FilterAPI 5', 'unsupported', 'operator'], ['AnthropicAPI 6', 'approximate', 'expression'],
      ['GeminiAPI 7', 'approximate', 'model-route'], ['CodeAPI 8', 'unsupported', 'code'], ['OpenAIAPI 9', 'approximate', 'model-route'],
      ['FilterAPI 10', 'unsupported', 'operator'], ['FilterAPI 11', 'unsupported', 'operator'], ['FilterAPI 12', 'unsupported', 'operator'],
      ['FilterAPI 13', 'unsupported', 'operator'], ['FilterAPI 14', 'unsupported', 'operator'], ['Step 15', 'unsupported', 'node-type']])
    const nodes = (parse(result.yaml) as { spec: { nodes: Record<string, { config: Record<string, unknown> }> } }).spec.nodes
    expect(nodes.FilterAPI_3!.config.condition).toBe('${{ inputs.n > 5 }}')
    expect(nodes.GeminiAPI_7!.config).toMatchObject({ provider: 'gemini', prompt: 'Improve ${{ nodes.AnthropicAPI_6.output }}' })
    expect(nodes.OpenAIAPI_9!.config).toMatchObject({ provider: 'openai', prompt: 'Describe the task.' })
    const rootless = { metadata: { version: '1.0.0' }, zaps: [{ title: 'Loop', nodes: { 1: node(1, 2), 2: node(2, 1) } }] }
    expect(importWorkflow(JSON.stringify(rootless), limits).mappings).toEqual([{ source: 'Start', sourceType: 'none', target: 'Start',
      kind: 'approximate', reason: 'trigger-mode' }])
  })

  it('handles edge cases of Make modules: filters, prompt sources, references, routers and missing fields', () => {
    const blueprint = { metadata: { version: 1 }, flow: [
      { id: 1, module: 'gateway:CustomWebHook' },
      { id: 2, module: 'openai-gpt-3:CreateCompletion', mapper: { prompt: 'Hi {{1.name}}' } },
      { id: 3, module: 'anthropic-claude:CreateMessage', mapper: { messages: [{ content: 'Use {{2.result}} {{1.0x}} {{9.z}} {{now}}' }, { content: 5 }] } },
      { id: 4, module: 'util:SetVariable2', filter: { conditions: [] } },
      { id: 5, module: 'builtin:BasicFeeder', filter: { name: 'Loop', conditions: [[{ a: '{{1.count}}', b: 'x', o: 'number:greater' }]] } },
      { id: 6, module: 'gemini-ai:Generate', mapper: {}, filter: { conditions: [[{ a: '{{3.text}}', b: 'y', o: 'text:equal' }]] } },
      { id: 7, module: 'x:plain', filter: { conditions: [[{ a: 'plain', b: 1, o: 'text:notequal' }]] } },
      { id: 8, module: 'x:unknown', filter: { conditions: [[{ a: '{{1.k}}', o: 'text:contain' }]] } },
      { id: 9, module: 'x:number', filter: { conditions: [[{ a: 5, o: 'text:equal' }]] } },
      { id: 10, module: 'x:groups', filter: { name: 'Two', conditions: [[{ a: '{{1.k}}', b: '1', o: 'text:equal' }], [{ a: '{{1.k}}', b: '2', o: 'text:equal' }]] } },
      { id: 11, module: 'builtin:BasicRouter', filter: { name: 'Unconditioned' } }, { id: 12, module: 'builtin:BasicRouter', routes: [{}, {}] },
      { id: 13, module: 'x:last', filter: { conditions: [[{ a: '{{1.size}}', b: '3', o: 'number:lessorequal' }]] } },
    ] }
    const result = importWorkflow(JSON.stringify(blueprint), limits)
    expect(result.title).toBe('Imported Make scenario')
    expect(result.mappings.map(item => [item.source, item.kind, item.reason])).toEqual([
      ['gateway:CustomWebHook 1', 'approximate', 'trigger-mode'], ['openai-gpt-3:CreateCompletion 2', 'approximate', 'model-route'],
      ['anthropic-claude:CreateMessage 3', 'approximate', 'expression'], ['Filter 4', 'unsupported', 'operator'],
      ['util:SetVariable2 4', 'unsupported', 'node-type'], ['Loop', 'unsupported', 'operator'], ['builtin:BasicFeeder 5', 'unsupported', 'loop'],
      ['Filter 6', 'unsupported', 'operator'], ['gemini-ai:Generate 6', 'approximate', 'model-route'], ['Filter 7', 'unsupported', 'operator'],
      ['x:plain 7', 'unsupported', 'node-type'], ['Filter 8', 'unsupported', 'operator'], ['x:unknown 8', 'unsupported', 'node-type'],
      ['Filter 9', 'unsupported', 'operator'], ['x:number 9', 'unsupported', 'node-type'], ['Two', 'unsupported', 'operator'],
      ['x:groups 10', 'unsupported', 'node-type'], ['Unconditioned', 'unsupported', 'operator'], ['builtin:BasicRouter 11', 'approximate', 'operator'],
      ['builtin:BasicRouter 12', 'approximate', 'operator'], ['Filter 13', 'exact', 'mapped'], ['x:last 13', 'unsupported', 'node-type']])
    const nodes = (parse(result.yaml) as { spec: { nodes: Record<string, { config: Record<string, unknown> }> } }).spec.nodes
    expect(nodes.openai_gpt_3_CreateCompletion_2!.config.prompt).toBe('Hi ${{ inputs.name }}')
    expect(nodes.anthropic_claude_CreateMessage_3!.config.prompt).toBe('Use ${{ nodes.openai_gpt_3_CreateCompletion_2.output }} {{1.0x}} {{9.z}} {{now}}')
    expect(nodes.Filter_13!.config.condition).toBe('${{ inputs.size <= 3 }}')
  })

  it('translates n8n expressions and routes conservatively', () => {
    const node = (name: string, type: string, parameters: object, typeVersion = 2) => ({ name, type, typeVersion, parameters })
    const source = { nodes: [
      node('Start', 'n8n-nodes-base.manualTrigger', {}, 1),
      node('Same name', 'n8n-nodes-base.code', { jsCode: 'return 1' }),
      node('Same-name', 'n8n-nodes-base.code', { jsCode: 'return 2' }),
      node('Numbers', 'n8n-nodes-base.if', { conditions: { combinator: 'or', conditions: [
        { leftValue: '={{ $json.count }}', rightValue: 3, operator: { type: 'number', operation: 'gt' } },
        { leftValue: '={{ $json.flag }}', operator: { type: 'boolean', operation: 'false' } },
        { leftValue: '={{ $json.note }}', operator: { type: 'string', operation: 'notExists' } },
        { leftValue: '={{ $json.count }}', rightValue: '={{ $json.limit }}', operator: { type: 'number', operation: 'lte' } }] } }),
      node('Contains', 'n8n-nodes-base.if', { conditions: { conditions: [{ leftValue: '={{ $json.note }}', rightValue: 'x', operator: { operation: 'contains' } }] } }),
      node('Mixed switch', 'n8n-nodes-base.switch', { rules: { values: [
        { conditions: { conditions: [{ leftValue: '={{ $json.a }}', rightValue: 1, operator: { operation: 'equals' } }] } },
        { conditions: { conditions: [{ leftValue: '={{ $json.b }}', rightValue: 2, operator: { operation: 'equals' } }] } }] } }, 3),
      node('Expression switch', 'n8n-nodes-base.switch', { rules: { values: [
        { conditions: { conditions: [{ leftValue: '={{ $json.a }}', rightValue: '={{ $json.b }}', operator: { operation: 'equals' } }] } }] } }, 3),
      node('Odd prompt', '@n8n/n8n-nodes-langchain.agent', { text: '={{ $json.items.map(i => i) }} and {{ $("Same name").item.json.v }} for {{ $json.name }}' }, 1),
      node('Start first', 'n8n-nodes-base.if', { conditions: { conditions: [{ leftValue: "={{ $('Start').item.json.count }}", rightValue: 1,
        operator: { operation: 'equals' } }] } }),
      node('Plain prompt', '@n8n/n8n-nodes-langchain.chainLlm', { prompt: 'Summarize' }, 1),
      node('Empty prompt', '@n8n/n8n-nodes-langchain.chainLlm', {}, 1),
      node('Bad condition', 'n8n-nodes-base.if', { conditions: { conditions: ['x'] } }),
      node('No left', 'n8n-nodes-base.if', { conditions: { conditions: [{ leftValue: '={{ $json.a.b() }}', operator: { operation: 'equals' } }] } }),
      node('No conditions', 'n8n-nodes-base.if', {}),
      node('No switch rules', 'n8n-nodes-base.switch', {}, 3),
    ], connections: {
      'Start': { main: [[{ node: 'Same name', type: 'main', index: 0 }]] },
      'Same name': { main: [[{ node: 'Same-name', type: 'main', index: 0 }]] },
      'Same-name': { main: [[{ node: 'Numbers', type: 'main', index: 0 }]] },
      'Numbers': { main: [[{ node: 'Contains', type: 'main', index: 0 }], [{ node: 'Mixed switch', type: 'main', index: 0 }]] },
      'Mixed switch': { main: [[{ node: 'Expression switch', type: 'main', index: 0 }]] },
      'Contains': { main: [[{ node: 'Odd prompt', type: 'main', index: 0 }], null] },
      'Odd prompt': { main: [[{ node: 'Plain prompt', type: 'main', index: 0 }]] },
      'Plain prompt': { main: [[{ node: 'Empty prompt', type: 'main', index: 0 }]] },
      'Empty prompt': { main: [[{ node: 'Bad condition', type: 'main', index: 0 }]] },
      'Bad condition': { main: [[{ node: 'No left', type: 'main', index: 0 }]] },
      'No left': { main: [[{ node: 'No conditions', type: 'main', index: 0 }]] },
      'No conditions': { main: [[{ node: 'No switch rules', type: 'main', index: 0 }]] },
      'No switch rules': { main: [[{ node: 'Start first', type: 'main', index: 0 }]] },
      'Expression switch': { main: [[{ node: 'Start', type: 'main', index: 0 }]] },
    } }
    const result = importWorkflow(JSON.stringify(source), limits)
    expect(result.title).toBe('Imported n8n workflow')
    expect(summary(result.mappings)).toEqual(['Start → Start: exact/mapped', 'Same name → Same_name: approximate/code',
      'Same-name → Same_name_2: approximate/code', 'Numbers → Numbers: exact/mapped', 'Contains → Contains: unsupported/operator',
      'Mixed switch → Mixed_switch: unsupported/operator', 'Expression switch → Expression_switch: unsupported/operator',
      'Odd prompt → Odd_prompt: approximate/expression', 'Start first → Start_first: exact/mapped',
      'Plain prompt → Plain_prompt: approximate/model-route',
      'Empty prompt → Empty_prompt: approximate/expression', 'Bad condition → Bad_condition: unsupported/operator',
      'No left → No_left: unsupported/operator', 'No conditions → No_conditions: unsupported/operator',
      'No switch rules → No_switch_rules: unsupported/operator'])
    const nodes = (parse(result.yaml) as { spec: { nodes: Record<string, { config: Record<string, string> }> } }).spec.nodes
    expect(nodes.Same_name_2!.config.input).toBe('${{ nodes.Same_name.output }}')
    expect(nodes.Numbers!.config.condition).toBe('${{ nodes.Same_name_2.output.count > 3 || !nodes.Same_name_2.output.flag'
      + ' || !exists(nodes.Same_name_2.output.note) || nodes.Same_name_2.output.count <= nodes.Same_name_2.output.limit }}')
    expect(nodes.Odd_prompt!.config.prompt).toBe('{{ $json.items.map(i => i) }} and ${{ nodes.Same_name.output.v }} for ${{ nodes.Contains.output.name }}')
    expect(nodes.Start_first!.config.condition).toBe('${{ inputs.count == 1 }}')
  })

  it('covers minimal and irregular sources without guessing', () => {
    const n8n = (value: object) => importWorkflow(JSON.stringify(value), limits)
    const bare = n8n({ name: '123 !', nodes: [{ name: 'Go', type: 'n8n-nodes-base.manualTrigger' }] })
    expect(doc(bare)).toMatchObject({ metadata: { id: 'imported-123' }, spec: { nodes: { Go: { type: 'trigger' },
      Go_result: { config: { value: '${{ inputs }}' } } } } })
    expect(doc(n8n({ name: '!!!', nodes: [{ name: '???', type: 'n8n-nodes-base.webhook', typeVersion: 1 }] })))
      .toMatchObject({ metadata: { id: 'imported-workflow' }, spec: { nodes: { step: { type: 'trigger' } } }, extensions: { 'jevable.ai/import': { fidelity: 'approximate' } } })
    const edges = n8n({ nodes: [
      { name: 'Go', type: 'n8n-nodes-base.manualTrigger' },
      { name: 'Check', type: 'n8n-nodes-base.if', typeVersion: 2, parameters: { conditions: { conditions: [
        { leftValue: '={{ $json }}', operator: { operation: 'exists' } },
        { leftValue: '={{ $json.a }}', rightValue: 'x', operator: { operation: 'equals' } },
        { leftValue: '={{ $json.a }}', operator: { type: 'boolean', operation: 'true' } },
        { leftValue: '={{ $json.b }}', operator: { type: 'boolean', operation: 'true' } },
        { leftValue: '={{ $json.b }}', rightValue: 'y', operator: { operation: 'equals' } },
        { leftValue: '={{ $json.c }}', rightValue: 'z', operator: { operation: 'equals' } },
        { leftValue: '={{ $json.c.d }}', rightValue: 1, operator: { operation: 'equals' } },
        { leftValue: '={{ $json.c.e }}', rightValue: 2, operator: { operation: 'equals' } },
        { leftValue: 5, rightValue: 5, operator: { operation: 'equals' } }] } } },
      { name: 'Missing right', type: 'n8n-nodes-base.if', typeVersion: 2, parameters: { conditions: { conditions: [
        { leftValue: '={{ $json.a }}', operator: { operation: 'equals' } }] } } },
      { name: 'Route', type: 'n8n-nodes-base.switch', typeVersion: 3, parameters: { rules: { values: [
        { conditions: { conditions: [{ leftValue: '={{ $json.k }}', rightValue: null, operator: { operation: 'equals' } }] } }] } } },
      { name: 'Bad rules', type: 'n8n-nodes-base.switch', typeVersion: 3, parameters: { rules: { values: ['x', { conditions: { conditions: ['y'] } }] } } },
      { name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2 },
      { name: 'Tool', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: {} },
    ], connections: {
      'Go': { main: [[{ node: 'Check', type: 'main', index: 0 }]] },
      'Check': { main: [[{ node: 'Route', type: 'main', index: 0 }], [{ node: 'Missing right', type: 'main', index: 0 }]] },
      'Route': { main: [[{ node: 'Bad rules', type: 'main', index: 0 }], [{ node: 'Code', type: 'main', index: 0 }]] },
      'Code': { ai_tool: [[{ node: 'Tool', type: 'ai_tool', index: 0 }]] },
    } })
    const spec = doc(edges).spec as { inputSchema: unknown; nodes: Record<string, { config: Record<string, unknown> }>; edges: unknown[] }
    expect(spec.inputSchema).toEqual({ type: 'object', required: ['a', 'b', 'c'], properties: { a: { type: 'boolean' },
      b: { type: 'boolean' }, c: { type: 'object', required: ['d', 'e'], properties: { d: { type: 'number' }, e: { type: 'number' } } } } })
    expect(spec.nodes.Check!.config.condition).toBe('${{ exists(inputs) && inputs.a == "x" && inputs.a && inputs.b && inputs.b == "y" && inputs.c == "z"'
      + ' && inputs.c.d == 1 && inputs.c.e == 2 && 5 == 5 }}')
    expect(spec.nodes.Route!.config).toEqual({ mode: 'switch', value: '${{ nodes.Check.output.k }}', cases: [{ port: 'case1', value: null }] })
    expect(spec.nodes.Code!.config.code).toBe('')
    expect(spec.edges).toContainEqual({ from: 'Route', to: 'Code', port: 'default' })
    expect(summary(edges.mappings)).toContain('Missing right → Missing_right: unsupported/operator')
    expect(summary(edges.mappings)).toContain('Bad rules → Bad_rules: unsupported/operator')

    const dify = (graph: object, version = '0.1.0') => importWorkflow(stringify({ version, app: { name: 'Flow' }, workflow: { graph } }), limits)
    expect(doc(dify({ nodes: [], edges: [] }))).toMatchObject({ spec: { nodes: { Start: { type: 'trigger' },
      Start_result: { config: { value: '${{ inputs }}' } } } } })
    const exact = dify({ nodes: [{ id: 's', data: { type: 'start' } }, { id: 'e', data: { type: 'end' } }], edges: [{ source: 's', target: 'e' }] })
    expect(doc(exact)).toMatchObject({ extensions: { 'jevable.ai/import': { fidelity: 'exact' } }, spec: { nodes: { e: { config: { value: {} } } } } })
    const legacy = dify({ nodes: [
      { id: 's', data: { type: 'start', variables: [{ variable: 'v', type: 'text-input', required: true }] } },
      { id: 'i', data: { type: 'if-else', title: 'Empty', conditions: [{ variable_selector: ['s', 'v'], comparison_operator: 'empty' }] } },
      { id: 'j', data: { type: 'if-else', title: 'Odd', cases: [{ case_id: 'x', conditions: ['bad'] }] } },
      { id: 'k', data: { type: 'if-else', title: 'Unknown', cases: [{ case_id: 'x', conditions: [{ variable_selector: ['nowhere', 'v'], comparison_operator: 'is' }] }] } },
      { id: 'c', data: { type: 'code', title: 'Plain', code_language: 'javascript' } },
      { id: 'd', data: { type: 'code', title: 'Named', code_language: 'javascript', code: 'x', variables: [{ variable: 5, value_selector: ['s', 'v'] }] } },
    ], edges: [{ source: 's', target: 'i' }, { source: 'i', target: 'c', sourceHandle: 'true' }, { source: 'i', target: 'd', sourceHandle: 'false' },
      { source: 'c', target: 'j' }, { source: 'j', target: 'k' }] })
    const nodes = (doc(legacy).spec as { nodes: Record<string, { config: Record<string, unknown> }> }).nodes
    expect(nodes.Empty!.config.condition).toBe('${{ !exists(inputs.v) }}')
    expect(nodes.Plain!.config).toMatchObject({ code: '', input: {} })
    expect(nodes.Named!.config.input).toEqual({})
    expect(summary(legacy.mappings)).toEqual(['s → s: exact/mapped', 'Empty → Empty: exact/mapped', 'Odd → Odd: unsupported/operator',
      'Unknown → Unknown: unsupported/operator', 'Plain → Plain: approximate/code', 'Named → Named: approximate/code'])
  })
})
