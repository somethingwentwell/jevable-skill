import { describe, expect, it } from 'vitest'
import { createHash, randomUUID, webcrypto } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { LocalRuntime } from '../src/runtime/index.ts'
import { createRunEvidence } from '../src/runtime/evidence.ts'
import { createPostgresRunEvidence } from '../src/runtime/postgres-evidence.ts'
import { prepareEvidenceDownload } from '../src/evidence/download.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const loop = await readFile(new URL('../examples/loop-approval.yaml', import.meta.url), 'utf8')
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const numbering = { format: 'jevable.node-attempts/v1', source: 'retained-intents', numbering: 'per-node-and-loop-scope' }
const admit = runInNewContext(`(${prepareEvidenceDownload.toString()})`, { crypto: webcrypto, TextEncoder }) as typeof prepareEvidenceDownload

async function fixture() {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-attempt-evidence-'))
  return { dataDirectory, owner: await LocalRuntime.open({ dataDirectory }) }
}

describe('node attempt evidence ordinals', () => {
  it('exports actual committed identities in both privacy modes without modifying the run or journal', async () => {
    const { owner } = await fixture()
    try {
      const run = await owner.run(echo, 'PRIVATE_VALUE'), events = await owner.events(run.id)
      for (const privateData of [false, true]) {
        const evidence = await owner.exportRun(run.id, privateData)
        expect(evidence.snapshot.nodeAttempts).toMatchObject(numbering)
        expect(evidence.snapshot.nodeAttempts.entries).toEqual(events.filter(event => event.kind === 'node-intent').map(event => {
          const data = event.data as { attempt: { id: string; nodeId: string } }
          return { attemptId: data.attempt.id, nodeId: data.attempt.nodeId, number: 1 }
        }))
        expect(JSON.stringify(evidence.snapshot.nodeAttempts)).not.toContain('PRIVATE_VALUE')
        await expect(admit({ runId: run.id, revision: run.revision }, evidence, privateData)).resolves.toHaveProperty('runId', run.id)
      }
      expect(await owner.events(run.id)).toEqual(events); expect(await owner.show(run.id)).toEqual(run)
    } finally { await owner.close() }
  })

  it('keeps scoped approval ordinals stable across reopen and never counts the next iteration as a retry', async () => {
    const f = await fixture(); let owner = f.owner
    try {
      const first = await owner.run(loop, ['PRIVATE_ONE', 'PRIVATE_TWO'])
      if (first.state.status !== 'waiting') throw Error('Expected first review')
      const before = await owner.exportRun(first.id)
      await owner.close(); owner = await LocalRuntime.open({ dataDirectory: f.dataDirectory })
      expect(await owner.exportRun(first.id)).toEqual(before)
      const second = await owner.decide(first.id, first.state.attempt.id, 'approve', 'PRIVATE_ACTOR')
      if (second.state.status !== 'waiting') throw Error('Expected second review')
      await owner.decide(first.id, second.state.attempt.id, 'reject', 'PRIVATE_ACTOR')
      const evidence = await owner.exportRun(first.id)
      expect(evidence.snapshot.nodeAttempts.entries.filter(entry => entry.nodeId === 'review')).toEqual([
        { attemptId: first.state.attempt.id, nodeId: 'review', scope: { loop: 'each', index: 0 }, number: 1 },
        { attemptId: second.state.attempt.id, nodeId: 'review', scope: { loop: 'each', index: 1 }, number: 1 },
      ])
      expect(JSON.stringify(evidence)).not.toContain('PRIVATE_')
    } finally { await owner.close() }
  })

  it('projects per-node/per-scope counts, not global event sequence numbers, and preserves PostgreSQL int64 identities', async () => {
    const { owner } = await fixture()
    try {
      const run = await owner.run(echo, 'value')
      // Synthetic projection inputs: these are not additional workflow executions or retry authority.
      const scopes = [undefined, undefined, { loop: 'each', index: 0 }, { loop: 'each', index: 0 }, { loop: 'each', index: 1 }]
      const events = scopes.map((scope, index) => ({ kind: 'node-intent' as const, at: run.updatedAt, sequence: index + 1,
        data: { attempt: { id: randomUUID(), nodeId: 'worker' }, scope: scope ?? null } }))
      const expected = [1, 2, 1, 2, 1]
      const local = createRunEvidence(run, events, false)
      expect(local.snapshot.nodeAttempts.entries.map(entry => entry.number)).toEqual(expected)
      const pgEvents = events.map((event, index) => ({ ...event, sequence: String(9007199254740993n + BigInt(index)), version: String(index + 1) }))
      const pg = createPostgresRunEvidence(run, pgEvents, String(events.length), false)
      expect(pg.snapshot.nodeAttempts).toEqual(local.snapshot.nodeAttempts)
      expect(pg.snapshot.journal.map(event => event.sequence)).toEqual(pgEvents.map(event => event.sequence))
      await expect(admit({ runId: run.id, revision: run.revision }, pg)).resolves.toHaveProperty('runId', run.id)
      const duplicate = [...events, { ...events[0]!, sequence: 6 }]
      expect(() => createRunEvidence(run, duplicate, false)).toThrow('corrupt')
    } finally { await owner.close() }
  })

  it.each(['number', 'duplicate-id', 'scope', 'order', 'missing', 'extra', 'source', 'format', 'identity', 'private-field', 'journal-scope'])
    ('refuses checksummed %s ordinal inconsistencies in the import-free download helper', async fault => {
      const attemptIds = [randomUUID(), randomUUID()], id = randomUUID(), revision = 'a'.repeat(64)
      const scope = { loop: 'each', index: 0 }
      const snapshot: any = { schemaVersion: 1, format: 'jevable.ai/run-evidence', run: { id, revision, status: 'waiting' },
        privacy: { payloads: 'excluded', actors: 'excluded', credentialStore: 'excluded' },
        journal: attemptIds.map((attemptId, index) => ({ kind: 'node-intent', sequence: index + 1, nodeId: 'worker', attemptId, scope })),
        nodeAttempts: { ...numbering, entries: attemptIds.map((attemptId, index) => ({ attemptId, nodeId: 'worker', scope, number: index + 1 })) } }
      const entries = snapshot.nodeAttempts.entries
      if (fault === 'number') entries[1].number = 1
      if (fault === 'duplicate-id') snapshot.journal[1].attemptId = attemptIds[0]
      if (fault === 'scope') entries[1].scope = { loop: 'each', index: 1 }
      if (fault === 'order') entries.reverse()
      if (fault === 'missing') entries.pop()
      if (fault === 'extra') entries.push({ ...entries[0] })
      if (fault === 'source') snapshot.nodeAttempts.source = 'provider-tries'
      if (fault === 'format') snapshot.nodeAttempts.format = 'unknown'
      if (fault === 'identity') entries[1].attemptId = randomUUID()
      if (fault === 'private-field') entries[0].input = 'PRIVATE_PAYLOAD'
      if (fault === 'journal-scope') snapshot.journal[0].scope = { loop: 'each', index: -1 }
      const envelope = { schemaVersion: 1, snapshot, checksum: { algorithm: 'sha256', encoding: 'JSON.stringify(snapshot)', value: digest(snapshot) } }
      await expect(admit({ runId: id, revision }, envelope)).rejects.toThrow()
    })
})
