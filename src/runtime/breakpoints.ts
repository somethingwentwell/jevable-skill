import { isDeepStrictEqual as same } from 'node:util'
import type { CompiledWorkflow, WorkflowCompilerLimits } from '../workflow/index.ts'
import { hasNode, findNode, advanceCheckpoint, initialCheckpoint, preparedAttemptMatches, checkpointMatches, type RunCheckpoint } from './run-evaluator.ts'
import { breakpointHitSchema, type ExecutionControl } from './control.ts'
import { executionCheckpointHash, nodeAttempt, approvalDecision, stoppedCheckpoint, type LocalRun, type JevableNodeAttempt } from './run-types.ts'
import { WorkflowRuntimeError } from './errors.ts'
import { breakpointConfiguration } from './breakpoint-metadata.ts'
export { breakpointConfiguration, breakpointAt, breakpointMetadata } from './breakpoint-metadata.ts'

export function validateBreakpoints(graph: CompiledWorkflow, command: ExecutionControl) {
  if (['pause', 'recover'].includes(command.mode) && command.breakpoints !== undefined) throw new WorkflowRuntimeError('invalid-command')
  if (command.breakpoints?.some(id => !hasNode(graph, id))) throw new WorkflowRuntimeError('invalid-command')
}
/** Bind hit history to admitted configuration and compiled checkpoint prefixes. Never execute during replay. */
export function checkBreakpointEvidence(run: LocalRun, events: readonly { kind: string; data: unknown }[],
  graph: CompiledWorkflow, limits: WorkflowCompilerLimits) {
  const controls: NonNullable<LocalRun['controlRequests']> = [], hits: NonNullable<LocalRun['breakpointHits']> = []
  const fail = (): never => { throw new WorkflowRuntimeError('corrupt') }
  // Older runs need no new history interpretation. New breakpoint histories must bind
  // each hit to the position actually settled at that point, not a later valid prefix.
  const replay = Boolean(run.breakpointHits?.length || run.controlRequests?.some(item => item.delegation !== undefined || ['pause', 'recover'].includes(item.mode))
    || events.some(event => event.kind === 'breakpoint-hit'))
  let cursor: RunCheckpoint = initialCheckpoint(graph), pending: JevableNodeAttempt | undefined
  let phase = 'paused'
  let cancelled = false
  for (const event of events) {
    if (event.kind === 'execution-requested') {
      const control = run.controlRequests?.[controls.length]
      if (!control) return fail()
      try { validateBreakpoints(graph, control) } catch { return fail() }
      if (control.delegation !== undefined || control.mode === 'pause' || control.mode === 'recover') {
        if (cancelled || cursor.status !== 'paused' || !['paused', 'executing'].includes(phase)
          || (phase === 'executing' && !pending) || (control.mode === 'recover' && phase !== 'executing')
          || (['step', 'continue'].includes(control.mode) && phase !== 'paused')) return fail()
        if (control.mode === 'recover') {
          const node = findNode(graph, cursor.next, cursor.scope)
          if (!node || !['llm', 'decision'].includes(node.plan.kind) || pending?.prepared.status !== 'ready') return fail()
        }
        const prior: LocalRun = { ...run, state: phase === 'executing' ? { ...cursor, status: 'executing', attempt: pending! } : cursor,
          controlRequests: controls, ...(hits.length ? { breakpointHits: hits } : {}) }
        delete prior.cancellation
        if (!hits.length) delete prior.breakpointHits
        if (executionCheckpointHash(prior) !== control.expectedCheckpointSha256) return fail()
      }
      controls.push(control)
    }
    if (replay && event.kind === 'node-intent') {
      const data = event.data as { attempt?: unknown; scope?: unknown }
      const parsed = nodeAttempt.safeParse(data?.attempt)
      if (!parsed.success || phase !== 'paused' || cursor.status !== 'paused' || controls.at(-1)?.mode === 'pause'
        || !same(data.scope ?? undefined, cursor.scope)
        || !preparedAttemptMatches(parsed.data, graph, run.input, cursor, limits.binding.data)) return fail()
      pending = parsed.data
    }
    if (event.kind === 'node-intent') phase = 'executing'
    if (replay && event.kind === 'node-trace') {
      const data = event.data as { attemptId?: unknown; trace?: unknown }
      const parsed = nodeAttempt.safeParse({ ...pending, trace: data?.trace })
      if (!pending || phase !== 'executing' || pending.trace || data?.attemptId !== pending.id || !parsed.success || !parsed.data.trace) return fail()
      pending = parsed.data
    }
    if (event.kind === 'approval-requested') phase = 'waiting'
    if (replay && (event.kind === 'node-result' || event.kind === 'approval-decided')) {
      const data = event.data as { attemptId?: unknown; nodeId?: unknown; status?: unknown; decision?: unknown }
      if (!pending || cursor.status !== 'paused' || data?.attemptId !== pending.id || data.nodeId !== cursor.next
        || phase !== (event.kind === 'node-result' ? 'executing' : 'waiting')) return fail()
      const final = stoppedCheckpoint(run.state)
      const inspection = run.state.steps[cursor.steps.length]?.inspection
        ?? (final.status === 'failed' ? final.inspection : undefined)
      const decision = event.kind === 'approval-decided' ? approvalDecision.safeParse(data.decision) : undefined
      if (decision && !decision.success) return fail()
      const next = advanceCheckpoint(graph, run.input, cursor, limits.binding.data, undefined, pending,
        inspection?.modelOutput, decision?.data)
      const actual = { ...next, steps: run.state.steps.slice(0, next.steps.length) }
      if (!checkpointMatches(actual, next) || (event.kind === 'node-result' && next.status !== data.status)) return fail()
      cursor = actual; pending = undefined
    }
    if (event.kind === 'node-result') phase = (event.data as { status?: string })?.status ?? 'unknown'
    if (event.kind === 'approval-decided') phase = 'paused' // The precise post-decision position is checked by prefix replay below.
    if (event.kind === 'cancellation-requested') cancelled = true
    if (event.kind === 'run-cancelled' || event.kind === 'loop-timeout') phase = 'terminal'
    if (event.kind !== 'breakpoint-hit') continue
    const parsed = breakpointHitSchema.safeParse(event.data)
    if (!parsed.success || phase !== 'paused' || cancelled || controls.at(-1)?.mode === 'pause') return fail()
    const hit = parsed.data, configuration = breakpointConfiguration({ controlRequests: controls })
    if (!configuration || configuration.requestId !== hit.configurationRequestId || !configuration.breakpoints!.includes(hit.nodeId)
      || hit.stepCount > run.state.steps.length) return fail()
    const state = { status: 'paused' as const, next: hit.nodeId, steps: run.state.steps.slice(0, hit.stepCount),
      ...(hit.scope ? { scope: hit.scope } : {}) }
    const prior: LocalRun = { ...run, state, controlRequests: controls, ...(hits.length ? { breakpointHits: hits } : {}) }
    delete prior.cancellation
    if (!hits.length) delete prior.breakpointHits
    if (executionCheckpointHash(prior) !== hit.checkpointSha256 || !checkpointMatches(state, cursor)) return fail()
    hits.push(hit)
  }
  if (!same(run.breakpointHits ?? [], hits)) return fail()
}
