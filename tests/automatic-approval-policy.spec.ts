import { describe, it, expect } from 'vitest'
import { parseAutomaticApprovalPolicy, planAutomaticApprovalNotifications } from '../src/notifications/automatic-policy.ts'
import { notificationSha256 } from '../src/notifications/schema.ts'
import { WorkflowRuntimeError } from '../src/runtime/errors.ts'

function refuses(work: () => unknown, code: string) {
  try { work() } catch (error) {
    expect(error).toBeInstanceOf(WorkflowRuntimeError)
    expect(error).toMatchObject({ code })
    return
  }
  throw new Error('Expected policy refusal')
}

const id = '01234567-1234-4567-89ab-0123456789ab', foreign = '11234567-1234-4567-89ab-0123456789ab'
const revision = 'a'.repeat(64), digest = 'b'.repeat(64), endpointSha256 = 'c'.repeat(64)
const destination = { id: 'review', endpointSha256 }
const release = { id, sha256: digest }, project = { id, generation: 1 }
const releaseScope = { kind: 'release' as const, ...release, revision }
const policy = (scope: unknown = releaseScope, eventKinds = ['requested']) => ({
  format: 'jevable.ai/automatic-approval-policy/v1', routes: [{ scope, endpointId: 'review', endpointSha256, eventKinds }],
})
const event = (kind = 'requested', extra: Record<string, unknown> = {}) => {
  const body = { source: 'urn:jevable:workflow-runtime', type: `ai.jevable.approval.${kind}`,
    time: '2026-10-01T00:00:00.000Z', data: { runId: id, revision, attemptId: id, nodeId: 'review',
      expiresAt: '2026-10-01T01:00:00.000Z', release, ...extra } }
  return { specversion: '1.0', datacontenttype: 'application/json', id: notificationSha256(body), ...body }
}

describe('strict automatic approval selection, without dispatch', () => {
  for (const kind of ['requested', 'decided', 'expired', 'cancelled']) it(`plans a stable identity for ${kind}`, () => {
    const p = policy(releaseScope, [kind]), e = event(kind)
    const first = planAutomaticApprovalNotifications(p, e, [destination])
    expect(first).toEqual(planAutomaticApprovalNotifications(p, structuredClone(e), [destination]))
    expect(first.dispatch).toBe('not-attempted')
    expect(first.requests).toHaveLength(1)
    expect(first.requests[0]).toMatchObject({ eventKind: kind, runId: id, attemptId: id, revision, endpointId: 'review' })
    expect(first.requests[0]!.requestId).toMatch(/^[a-f\d]{8}-[a-f\d]{4}-8[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/u)
    expect(first.requests[0]).not.toHaveProperty('redeliverOf')
    expect(first.actor).toBe(`automatic:${first.policySha256}`)
  })
  it('requires exact project generation/revision rather than current accepted state', () => {
    const p = policy({kind:'project', ...project, revision})
    expect(planAutomaticApprovalNotifications(p, event('requested', {project}), [destination]).requests).toHaveLength(1)
    expect(planAutomaticApprovalNotifications(p, event('requested', {project:{...project,generation:2}}), [destination]).requests).toEqual([])
    expect(planAutomaticApprovalNotifications(p, event('requested', {revision:digest,project}), [destination]).requests).toEqual([])
  })
  it('does not select foreign releases, checksums, kinds or unscoped events', () => {
    for (const extra of [{release:{...release,id:foreign}}, {release:{...release,sha256:revision}}, {release:undefined}])
      expect(planAutomaticApprovalNotifications(policy(), event('requested',extra), [destination]).requests).toEqual([])
    expect(planAutomaticApprovalNotifications(policy(), event('decided'), [destination]).requests).toEqual([])
  })
  it('refuses absent or changed selected destinations without retargeting', () => {
    refuses(() => planAutomaticApprovalNotifications(policy(), event(), []), 'conflict')
    refuses(() => planAutomaticApprovalNotifications(policy(), event(), [{...destination,endpointSha256:digest}]), 'conflict')
    refuses(() => planAutomaticApprovalNotifications(policy(), event(), [destination,destination]), 'invalid-command')
  })
  it('refuses event substitution even when all selected pins still match', () => {
    const changed = event(); changed.data.nodeId = 'different'
    refuses(() => planAutomaticApprovalNotifications(policy(), changed, [destination]), 'corrupt')
  })
  it('canonicalizes route order and kind order without mutating caller values', () => {
    const first = policy(releaseScope, ['decided','requested'])
    first.routes.push({...first.routes[0]!,endpointId:'other'})
    const before = structuredClone(first), second = structuredClone(first)
    second.routes.reverse(); second.routes.forEach(x => x.eventKinds.reverse())
    const endpoints = [destination,{...destination,id:'other'}]
    expect(planAutomaticApprovalNotifications(first,event(),endpoints)).toEqual(planAutomaticApprovalNotifications(second,event(),endpoints))
    expect(first).toEqual(before)
  })
  it('does not double-send overlapping project/release routes for one event', () => {
    const p = policy(); p.routes.push({...p.routes[0]!, scope:{kind:'project',...project,revision}})
    refuses(() => planAutomaticApprovalNotifications(p,event('requested',{project}),[destination]), 'conflict')
  })
  it('refuses overlapping same-scope routes and duplicate kinds', () => {
    const p = policy(); p.routes.push({...p.routes[0]!})
    refuses(() => parseAutomaticApprovalPolicy(p), 'invalid-command')
    refuses(() => parseAutomaticApprovalPolicy(policy(releaseScope,['requested','requested'])), 'invalid-command')
  })
  for (const value of [undefined, {}, {...policy(),enabled:true}, policy({kind:'release',id,sha256:digest}),
    policy({kind:'project',id,generation:0,revision}), policy(releaseScope,['unknown']),
    {...policy(),routes:[]}, {...policy(),routes:Array.from({length:33},()=>policy().routes[0])},
    {...policy(),actor:'caller'}, {...policy(),url:'https://unreviewed.example'}])
    it('refuses missing, widened or unbounded policy without authority defaults', () => refuses(() => parseAutomaticApprovalPolicy(value), 'invalid-command'))
  it('changes identity when an event, destination or reviewed policy changes', () => {
    const a = planAutomaticApprovalNotifications(policy(),event(),[destination])
    const b = planAutomaticApprovalNotifications(policy(releaseScope,['requested','decided']),event(),[destination])
    const p = policy(); p.routes[0]!.endpointSha256 = digest
    const c = planAutomaticApprovalNotifications(p,event(),[{...destination,endpointSha256:digest}])
    const d = planAutomaticApprovalNotifications(policy(),event('requested',{runId:foreign}),[destination])
    expect(new Set([a,b,c,d].map(x=>x.requests[0]!.requestId)).size).toBe(4)
  })
})
