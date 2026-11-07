import { z } from 'zod'
import { PostgresJournal, JournalError } from '../storage/postgres.ts'
import { withDomainWrite } from '../storage/domain-owner.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { admitGrantAction, parseGrantAction, type GrantActionTarget } from './actions.ts'
import type { GrantPolicyObserver } from './policy-observation.ts'
import { journalConditionHash, parseJournalConditions, type JournalConditions } from '../storage/conditions.ts'
import { GRANT_LIMITS, parseGrantId, parseGrantIssue, parseGrantRevoke, parseGrantPage, inspectGrant, inspectGrantHistory,
  issueGrantRecord, revokeGrantRecord, sameGrantIssue, grantHistory, grantMetadata, grantTokenProof, grantPrincipal,
  type GrantScope, type GrantPageRequest, type GrantPage } from './grants.ts'

export class PostgresGrantStore {
  constructor(private readonly journal: PostgresJournal, private readonly maxGrants: number = GRANT_LIMITS.records,
    private readonly policyObserver?: GrantPolicyObserver) {
    if (!Number.isSafeInteger(maxGrants) || maxGrants < 1 || maxGrants > GRANT_LIMITS.records) throw new WorkflowRuntimeError('invalid-command')
  }
  private owned<T>(work: () => Promise<T>) { return withDomainWrite(this.journal, async () => {
    try { return await work() } catch (error) { if (error instanceof JournalError && error.code === 'conflict') throw new WorkflowRuntimeError('conflict'); throw error }
  }) }
  private async read(id: string) {
    const row = await this.journal.get('access-grants', id)
    if (!row) return undefined
    const record = inspectGrant(row.value)
    if (row.deleted || row.key !== record.id || row.version !== String(record.generation)) throw new WorkflowRuntimeError('corrupt')
    const events = await this.journal.events('0', 3, ['access-grants'], id)
    const history = events.events.map(item => { const event = item.data as { kind?: unknown; requestId?: unknown }
      if (!event || event.kind !== item.kind || event.requestId !== item.batchId) throw new WorkflowRuntimeError('corrupt'); return event })
    inspectGrantHistory(record, history)
    return record
  }
  get(value: string) { const id = parseGrantId(value); return this.owned(async () => {
    const record = await this.read(id); if (!record) throw new WorkflowRuntimeError('not-found'); return grantMetadata(record)
  }) }
  /** Internal historical run replay; the reader already holds the shared domain gate. Never authorizes an action. */
  async metadataForReplay(value: string) {
    const record = await this.read(parseGrantId(value))
    if (!record) throw new WorkflowRuntimeError('corrupt')
    return grantMetadata(record)
  }
  page(value: GrantPageRequest = {}): Promise<GrantPage> { const { after, limit } = parseGrantPage(value)
    return this.owned(async () => {
      if (after && !await this.read(after)) throw new WorkflowRuntimeError('not-found')
      const page = await this.journal.page('access-grants', after, limit), at = new Date().toISOString(), records = []
      for (const row of page.records) { const record = await this.read(row.key); if (!record) throw new WorkflowRuntimeError('corrupt'); records.push(grantMetadata(record, at)) }
      return { schemaVersion: 1, observedAt: at, grants: records, nextCursor: page.nextCursor }
    })
  }
  issue(value: unknown, checkScope: (scope: GrantScope, at: string) => Promise<void>) {
    const command = parseGrantIssue(value)
    return this.owned(async () => {
      const previous = await this.read(command.id)
      if (previous) { if (!sameGrantIssue(previous, command)) throw new WorkflowRuntimeError('conflict'); return grantMetadata(previous) }
      if (await this.journal.receipt(command.id)) throw new WorkflowRuntimeError('conflict')
      if (await this.journal.count('access-grants') >= this.maxGrants) throw new WorkflowRuntimeError('limit')
      const at = new Date().toISOString(), record = issueGrantRecord(command, at); await checkScope(record.scope, at)
      await this.journal.commit({ id: command.id, changes: [{ operation: 'put', collection: 'access-grants', key: record.id, expectedVersion: '0', value: z.json().parse(record) }],
        events: [{ collection: 'access-grants', key: record.id, kind: 'grant-issued', data: z.json().parse(grantHistory(record)) }] })
      return grantMetadata(record, at)
    })
  }
  revoke(value: unknown) {
    const command = parseGrantRevoke(value)
    return this.owned(async () => {
      const previous = await this.read(command.id); if (!previous) throw new WorkflowRuntimeError('not-found')
      const at = new Date().toISOString(), record = revokeGrantRecord(previous, command, at)
      if (record === previous) return grantMetadata(record, at)
      if (await this.journal.receipt(command.requestId)) throw new WorkflowRuntimeError('conflict')
      await this.journal.commit({ id: command.requestId, changes: [{ operation: 'put', collection: 'access-grants', key: record.id, expectedVersion: '1', value: z.json().parse(record) }],
        events: [{ collection: 'access-grants', key: record.id, kind: 'grant-revoked', data: z.json().parse(grantHistory(record, previous)) }] })
      return grantMetadata(record, at)
    })
  }
  lookup(token: unknown) { const proof = grantTokenProof(token); if (!proof) return Promise.resolve(null)
    return this.owned(async () => { const record = await this.read(proof.id); return record ? grantPrincipal(record, proof) : null }) }
  /** Internal read/retry admission only. Caller already holds the domain gate; never authorizes a mutation. */
  async callerForReadInDomain(token: unknown, permission: 'start' | 'read' | 'control' | 'cancel') {
    const proof = grantTokenProof(token)
    if (!proof) throw new WorkflowRuntimeError('not-found')
    const record = await this.read(proof.id), principal = record ? grantPrincipal(record, proof) : null
    if (!principal || principal.scope.kind !== 'caller' || !principal.scope.permissions.includes(permission))
      throw new WorkflowRuntimeError('not-found')
    return principal
  }
  /** Internal receipt/current-target admission. Caller holds the shared domain gate; this never authorizes a mutation. */
  async reviewerForReadInDomain(token: unknown, action: string) {
    const proof = grantTokenProof(token)
    if (!proof) throw new WorkflowRuntimeError('not-found')
    const record = await this.read(proof.id), principal = record ? grantPrincipal(record, proof) : null
    if (!principal || principal.scope.kind !== 'reviewer' || !principal.scope.decisions.includes(action)) throw new WorkflowRuntimeError('not-found')
    return principal
  }
  /** Internal planning only: the writer MUST submit these conditions with its exact batch. No permission survives unguarded dispatch. */
  planAction(token: unknown, action: unknown, readTarget: () => Promise<{ target: GrantActionTarget; condition: JournalConditions['records'][number] }>) {
    const request = parseGrantAction(action), proof = grantTokenProof(token)
    if (!proof) return Promise.reject(new WorkflowRuntimeError('not-found'))
    return this.owned(async () => {
      const record = await this.read(proof.id)
      if (!record || !grantPrincipal(record, proof)) throw new WorkflowRuntimeError('not-found')
      // Only a verified retained reader may supply a target and its exact journal snapshot pin.
      const { target, condition } = await readTarget()
      const admission = admitGrantAction(record, proof, request, target, undefined, this.policyObserver)
      const collection = target.kind === 'release' ? 'releases' : 'runs', key = target.kind === 'release' ? target.release.id : target.runId
      if (condition.collection !== collection || condition.key !== key) throw new WorkflowRuntimeError('corrupt')
      const conditions = parseJournalConditions({ records: [
        { collection: 'access-grants', key: record.id, version: String(record.generation), sha256: journalConditionHash(record) }, condition,
      ], notBefore: admission.admittedAt, expiresAt: admission.expiresAt })
      return { admission, conditions }
    })
  }
  validate() {
    return this.owned(async () => {
      const seen = new Set<string>(); let cursor: string | undefined, expected = 0
      do {
        const page = await this.journal.page('access-grants', cursor, 200)
        for (const row of page.records) { const id = row.key
          if (seen.has(id)) throw new WorkflowRuntimeError('corrupt'); seen.add(id)
          if (seen.size > this.maxGrants) throw new WorkflowRuntimeError('limit')
          const record = await this.read(id); if (!record) throw new WorkflowRuntimeError('corrupt'); expected += record.generation
        }
        if (page.nextCursor !== null && (page.nextCursor === cursor || !seen.has(page.nextCursor))) throw new WorkflowRuntimeError('corrupt')
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      let after = '0', observed = 0
      for (;;) { const page = await this.journal.events(after, 200, ['access-grants'])
        if (!page.events.length) break
        for (const event of page.events) if (!seen.has(event.key) || ++observed > expected) throw new WorkflowRuntimeError('corrupt')
        if (page.cursor === after) throw new WorkflowRuntimeError('corrupt'); after = page.cursor
      }
      if (observed !== expected) throw new WorkflowRuntimeError('corrupt')
    })
  }
}
