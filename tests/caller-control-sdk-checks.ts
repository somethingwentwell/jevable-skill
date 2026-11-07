import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { LocalRuntime } from '../src/runtime/local.ts'
import type { GrantScope } from '../src/access/grants.ts'
import { callerControlCheckpointSchema, callerControlReceiptSchema } from '../src/access/caller-control.ts'
import { executionCheckpointHash } from '../src/runtime/run-types.ts'

type Host = Pick<LocalRuntime, 'startWithGrant' | 'show' | 'advance' | 'advanceWithGrant' | 'controlCheckpointWithGrant'
  | 'readWithGrant' | 'cancelWithGrant' | 'revokeGrant'>
interface Fixture { owner: Host; issue(permissions: Extract<GrantScope, { kind: 'caller' }>['permissions']): Promise<{ id: string; token: string }>
  events(id: string): Promise<unknown[]> }
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
export const callerControlModelSource = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'control-model', name: 'Control model' },
  spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    write: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
      prompt: '${{ inputs }}', responseFormat: 'text', generation: { maxTokens: 20, stream: false }, historyScope: 'none',
      execution: { timeoutSeconds: 60, maxAttempts: 1 } } }, end: { type: 'output', config: { value: '${{ nodes.write.output }}' } } },
    edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })

/** Source-level backend parity only. The PostgreSQL setup remains explicitly a journal double. */
export function callerControlSdkChecks(label: string, setup: (source?: string) => Promise<Fixture>) {
  describe(label, () => {
    async function started(source?: string) {
      const f = await setup(source), caller = await f.issue(['control', 'start']), id = randomUUID()
      await f.owner.startWithGrant(caller.token, source ? { message: 'PRIVATE_INPUT' } : 'PRIVATE_INPUT', { id, paused: true })
      const checkpoint = await f.owner.controlCheckpointWithGrant(caller.token, id)
      return { ...f, caller, id, checkpoint, request: { requestId: randomUUID(), mode: 'step' as const, expectedCheckpointSha256: checkpoint.checkpointSha256 } }
    }
    it('steps, pauses, configures/clears a breakpoint and completes without output/read or owner authority', async () => {
      const f = await started(), ownerAdvance = vi.spyOn(f.owner, 'advance'), id = f.id
      expect(callerControlCheckpointSchema.parse(f.checkpoint)).toEqual(f.checkpoint)
      const stepped = await f.owner.advanceWithGrant(f.caller.token, id.toUpperCase(), { ...f.request, requestId: f.request.requestId.toUpperCase() })
      expect(stepped).toMatchObject({ id, status: 'paused', mode: 'step', requestId: f.request.requestId })
      expect(callerControlReceiptSchema.parse(stepped)).toEqual(stepped)
      const record = await f.owner.show(id)
      expect(record.state.steps).toHaveLength(1)
      expect(record.controlRequests?.[0]).toMatchObject({ actor: `grant:${f.caller.id}`, delegation: { grantId: f.caller.id } })
      const pause = await f.owner.advanceWithGrant(f.caller.token, id, { requestId: randomUUID(), mode: 'pause', expectedCheckpointSha256: stepped.checkpointSha256 })
      expect(pause.status).toBe('paused'); expect((await f.owner.show(id)).state.steps).toHaveLength(1)
      if (record.state.status !== 'paused') throw Error('fixture must be paused')
      const stopped = await f.owner.advanceWithGrant(f.caller.token, id, { requestId: randomUUID(), mode: 'continue', expectedCheckpointSha256: pause.checkpointSha256, breakpoints: [record.state.next] })
      expect(stopped.status).toBe('paused'); expect((await f.owner.show(id)).state.steps).toHaveLength(1)
      const done = await f.owner.advanceWithGrant(f.caller.token, id, { requestId: randomUUID(), mode: 'continue', expectedCheckpointSha256: stopped.checkpointSha256, breakpoints: [] })
      expect(done.status).toBe('completed'); expect((await f.owner.show(id)).state).toMatchObject({ output: 'PRIVATE_INPUT' })
      expect(ownerAdvance).not.toHaveBeenCalled()
      expect(JSON.stringify([f.checkpoint, stepped, pause, stopped, done])).not.toMatch(/PRIVATE|actor|grantId|delegation|yaml|input|output|steps|scope|deadline|breakpoints/)
      await expect(f.owner.readWithGrant(f.caller.token, id)).rejects.toHaveProperty('code', 'not-found')
      await expect(f.owner.cancelWithGrant(f.caller.token, id, { requestId: randomUUID() })).rejects.toHaveProperty('code', 'not-found')
      const events = await f.events(id)
      expect(await f.owner.advanceWithGrant(f.caller.token, id, f.request)).toMatchObject({ requestId: f.request.requestId, status: 'completed' })
      expect(await f.events(id)).toEqual(events)
      expect((await f.owner.controlCheckpointWithGrant(f.caller.token, id)).status).toBe('completed')
      expect(await f.events(id)).toEqual(events)
    })
    it.each(['actor', 'at', 'delegation', 'scope', 'grantId', 'authority', 'release', 'traceParent', 'unknown'])('refuses caller-supplied %s before context or writes', async key => {
      const f = await started(), events = await f.events(f.id), hook = vi.fn()
      await expect(f.owner.advanceWithGrant(f.caller.token, f.id, { ...f.request, [key]: 'forged' }, hook)).rejects.toHaveProperty('code', 'invalid-command')
      expect(hook).not.toHaveBeenCalled(); expect(await f.events(f.id)).toEqual(events)
    })
    it('filters foreign/missing runs and insufficient permission before a trusted context', async () => {
      const f = await started(), other = await f.issue(['control', 'start']), noControl = await f.issue(['read', 'start']), hook = vi.fn()
      for (const token of [other.token, noControl.token]) {
        await expect(f.owner.controlCheckpointWithGrant(token, f.id, hook)).rejects.toHaveProperty('code', 'not-found')
        await expect(f.owner.advanceWithGrant(token, f.id, f.request, hook)).rejects.toHaveProperty('code', 'not-found')
      }
      await expect(f.owner.advanceWithGrant(f.caller.token, randomUUID(), f.request, hook)).rejects.toHaveProperty('code', 'not-found')
      expect(hook).not.toHaveBeenCalled()
    })
    it.each(['new-revoked', 'new-expired', 'retry-revoked', 'retry-expired', 'inspect-revoked', 'inspect-expired'])('reauthenticates %s after awaited context without a run write', async kind => {
      const f = await started()
      if (kind.startsWith('retry')) await f.owner.advanceWithGrant(f.caller.token, f.id, f.request)
      const events = await f.events(f.id)
      const hook = async (_pin: unknown, execute: () => Promise<any>) => {
        if (kind.endsWith('revoked')) await f.owner.revokeGrant({ id: f.caller.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:test' })
        else vi.setSystemTime('2026-10-03T00:00:00.000Z')
        await Promise.resolve(); return execute()
      }
      const result = kind.startsWith('inspect') ? f.owner.controlCheckpointWithGrant(f.caller.token, f.id, hook)
        : f.owner.advanceWithGrant(f.caller.token, f.id, f.request, hook)
      await expect(result).rejects.toHaveProperty('code', 'not-found')
      expect(await f.events(f.id)).toEqual(events)
    })
    it.each(['step', 'continue', 'pause', 'recover'] as const)('cannot use %s to cross an approval wait or imply a decision', async mode => {
      const f = await started(approval)
      const waiting = await f.owner.advanceWithGrant(f.caller.token, f.id, { ...f.request, mode: 'continue' })
      expect(waiting.status).toBe('waiting')
      const events = await f.events(f.id)
      await expect(f.owner.advanceWithGrant(f.caller.token, f.id, { requestId: randomUUID(), mode, expectedCheckpointSha256: waiting.checkpointSha256 })).rejects.toHaveProperty('code', 'conflict')
      expect(await f.events(f.id)).toEqual(events); expect((await f.owner.show(f.id)).state.status).toBe('waiting')
    })
    it.each(['mode', 'hash', 'breakpoints'] as const)('rejects altered %s on a retained UUID, rather than executing again', async kind => {
      const f = await started(); await f.owner.advanceWithGrant(f.caller.token, f.id, f.request)
      const events = await f.events(f.id), request = { ...f.request, ...(kind === 'mode' ? { mode: 'continue' as const }
        : kind === 'hash' ? { expectedCheckpointSha256: 'b'.repeat(64) } : { breakpoints: [] }) }
      await expect(f.owner.advanceWithGrant(f.caller.token, f.id, request)).rejects.toHaveProperty('code', 'conflict')
      expect(await f.events(f.id)).toEqual(events)
    })
    it('captures the strict command and isolates the reviewed release pin from context mutation', async () => {
      const f = await started(), request = { ...f.request, breakpoints: [] as string[] }, expected = request.requestId
      const result = await f.owner.advanceWithGrant(f.caller.token, f.id, request, async (pin, execute) => {
        pin.id = randomUUID(); request.requestId = randomUUID(); request.breakpoints.push('missing'); await Promise.resolve(); return execute()
      })
      expect(result).toMatchObject({ requestId: expected, status: 'paused' })
      expect((await f.owner.show(f.id)).controlRequests?.[0]?.breakpoints).toEqual([])
    })
    it('refuses stale review, malformed identity and an owner request adoption without a write', async () => {
      const f = await started(), events = await f.events(f.id)
      await expect(f.owner.advanceWithGrant(f.caller.token, f.id, { ...f.request, expectedCheckpointSha256: 'b'.repeat(64) })).rejects.toHaveProperty('code', 'conflict')
      await expect(f.owner.advanceWithGrant(f.caller.token, f.id, {} as never)).rejects.toHaveProperty('code', 'invalid-command')
      await expect(f.owner.controlCheckpointWithGrant(f.caller.token, 'not-a-uuid')).rejects.toHaveProperty('code', 'invalid-command')
      expect(await f.events(f.id)).toEqual(events)
      const ownerRecord = await f.owner.advance(f.id, f.request, 'owner:test'), after = await f.events(f.id)
      expect(ownerRecord.state.steps).toHaveLength(1)
      await expect(f.owner.advanceWithGrant(f.caller.token, f.id, f.request)).rejects.toHaveProperty('code', 'conflict')
      expect(await f.events(f.id)).toEqual(after)
      expect((await f.owner.controlCheckpointWithGrant(f.caller.token, f.id)).checkpointSha256).toBe(executionCheckpointHash(ownerRecord))
    })
  })
}
