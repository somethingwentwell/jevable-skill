import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalRuntime } from '../src/runtime/index.ts'

const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const owners: { owner: LocalRuntime; directory: string }[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const { owner, directory } of owners.splice(0).reverse()) {
    await owner.close()
    await rm(directory, { recursive: true, force: true })
  }
})

async function waiting(source = approval) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-approval-race-'))
  const owner = await LocalRuntime.open({ dataDirectory: directory })
  owners.push({ owner, directory })
  const run = await owner.run(source, { message: 'PRIVATE_SYNTHETIC_REVIEW' }, { id: randomUUID() })
  expect(run.state.status).toBe('waiting')
  if (run.state.status !== 'waiting') throw Error('missing approval')
  const events = await owner.events(run.id)
  expect(events.filter(event => event.kind === 'approval-decided')).toHaveLength(0)
  return { owner, run, attemptId: run.state.attempt.id, eventsBefore: events }
}

async function terminalEvidence(owner: LocalRuntime, id: string) {
  const run = await owner.show(id)
  const events = await owner.events(id)
  const evidence = await owner.exportRun(id)
  expect(evidence.snapshot.run.id).toBe(id)
  expect(evidence.checksum.value).toMatch(/^[a-f0-9]{64}$/)
  return { run, events, evidenceSha256: evidence.checksum.value }
}

describe('real SQLite approval settlement races (one exclusive runtime owner)', () => {
  it.each(['approve', 'reject'] as const)('commits only one of two competing actor decisions when %s starts first', async firstAction => {
    const { owner, run, attemptId, eventsBefore } = await waiting()
    const otherAction = firstAction === 'approve' ? 'reject' : 'approve'
    const outcomes = await Promise.allSettled([
      owner.decide(run.id, attemptId, firstAction, 'synthetic-reviewer-a'),
      owner.decide(run.id, attemptId, otherAction, 'synthetic-reviewer-b'),
    ])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1)
    const refused = outcomes.find(outcome => outcome.status === 'rejected')
    expect(refused).toMatchObject({ reason: { code: expect.stringMatching(/^(busy|conflict)$/) } })
    const { run: final, events, evidenceSha256 } = await terminalEvidence(owner, run.id)
    expect(final.state.status).toMatch(/^(completed|failed)$/)
    expect(events.filter(event => event.kind === 'approval-decided')).toHaveLength(1)
    expect(events.filter(event => event.kind === 'run-cancelled')).toHaveLength(0)
    expect(events.length).toBeGreaterThan(eventsBefore.length)
    expect(events.find(event => event.kind === 'approval-decided')?.data)
      .toMatchObject({ decision: { kind: 'action', action: firstAction, actor: 'synthetic-reviewer-a' } })
    if (final.state.status === 'completed') expect(final.state.output).toBe('approve')
    else {
      expect(final.state.status).toBe('failed')
      if (final.state.status !== 'failed') throw Error('unexpected terminal state')
      expect(final.state.code).toBe('approval-rejected')
    }
    const unchanged = await terminalEvidence(owner, run.id)
    expect(unchanged.run).toEqual(final)
    expect(unchanged.events).toEqual(events)
    expect(unchanged.evidenceSha256).toBe(evidenceSha256)
  })

  it('settles a cancellation admitted during approval before any approval decision commits', async () => {
    const { owner, run, attemptId } = await waiting()
    const pending = owner.decide(run.id, attemptId, 'approve', 'synthetic-reviewer-a')
    const requestId = randomUUID()
    const requested = owner.cancel(run.id, requestId, 'synthetic-operator-b')
    expect(requested.cancellation?.id).toBe(requestId)
    await Promise.allSettled([pending])
    const { run: final, events, evidenceSha256 } = await terminalEvidence(owner, run.id)
    expect(final.state.status).toBe('cancelled')
    expect(events.filter(event => event.kind === 'cancellation-requested')).toHaveLength(1)
    expect(events.filter(event => event.kind === 'run-cancelled')).toHaveLength(1)
    expect(events.filter(event => event.kind === 'approval-decided')).toHaveLength(0)
    expect(owner.cancel(run.id, requestId, 'synthetic-operator-b')).toEqual(final)
    const unchanged = await terminalEvidence(owner, run.id)
    expect(unchanged.events).toEqual(events)
    expect(unchanged.evidenceSha256).toBe(evidenceSha256)
  })

  it('refuses a new approval after cancellation is already committed', async () => {
    const { owner, run, attemptId } = await waiting()
    owner.cancel(run.id, randomUUID(), 'synthetic-operator-b')
    const { run: before, events: beforeEvents } = await terminalEvidence(owner, run.id)
    expect(before.state.status).toBe('cancelled')
    await expect(owner.decide(run.id, attemptId, 'approve', 'synthetic-reviewer-a'))
      .rejects.toHaveProperty('code', 'conflict')
    const after = await terminalEvidence(owner, run.id)
    expect(after.run).toEqual(before)
    expect(after.events).toEqual(beforeEvents)
  })

  it('refuses a new cancellation after approval has already committed', async () => {
    const { owner, run, attemptId } = await waiting()
    const decided = await owner.decide(run.id, attemptId, 'approve', 'synthetic-reviewer-a')
    expect(decided.state.status).toBe('completed')
    const { events: beforeEvents, evidenceSha256 } = await terminalEvidence(owner, run.id)
    expect(() => owner.cancel(run.id, randomUUID(), 'synthetic-operator-b'))
      .toThrow(expect.objectContaining({ code: 'conflict' }))
    const after = await terminalEvidence(owner, run.id)
    expect(after.run).toEqual(decided)
    expect(after.events).toEqual(beforeEvents)
    expect(after.evidenceSha256).toBe(evidenceSha256)
  })

  it('records only one expiry when two late actor decisions race at the deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-16T00:00:00.000Z'))
    const source = approval.replace('expiresAfter: 24h', 'expiresAfter: 1s')
    expect(source).not.toBe(approval)
    const { owner, run, attemptId, eventsBefore } = await waiting(source)
    expect((await owner.show(run.id)).state.status).toBe('waiting')
    vi.setSystemTime(new Date('2026-10-16T00:00:01.000Z'))
    const outcomes = await Promise.allSettled([
      owner.decide(run.id, attemptId, 'approve', 'synthetic-reviewer-a'),
      owner.decide(run.id, attemptId, 'reject', 'synthetic-reviewer-b'),
    ])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1)
    const { run: final, events } = await terminalEvidence(owner, run.id)
    expect(final.state).toMatchObject({ status: 'failed', code: 'approval-expired' })
    const decisions = events.filter(event => event.kind === 'approval-decided')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.data).toMatchObject({ decision: { kind: 'expired' } })
    expect(events.filter(event => event.kind === 'run-cancelled')).toHaveLength(0)
    expect(events.length).toBeGreaterThan(eventsBefore.length)
    await expect(owner.decide(run.id, attemptId, 'approve', 'synthetic-reviewer-c'))
      .rejects.toHaveProperty('code', 'conflict')
    expect((await terminalEvidence(owner, run.id)).events).toEqual(events)
  })

  it('does not also commit an expired approval when cancellation arrives at an elapsed deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-16T00:00:00.000Z'))
    const { owner, run, attemptId } = await waiting(approval.replace('expiresAfter: 24h', 'expiresAfter: 1s'))
    vi.setSystemTime(new Date('2026-10-16T00:00:01.000Z'))
    const pending = owner.decide(run.id, attemptId, 'approve', 'synthetic-reviewer-a')
    const requestId = randomUUID()
    owner.cancel(run.id, requestId, 'synthetic-operator-b')
    await Promise.allSettled([pending])
    const { run: final, events } = await terminalEvidence(owner, run.id)
    expect(final.state.status).toBe('cancelled')
    expect(events.filter(event => event.kind === 'approval-decided')).toHaveLength(0)
    expect(events.filter(event => event.kind === 'run-cancelled')).toHaveLength(1)
  })
})
