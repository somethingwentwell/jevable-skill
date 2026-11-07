import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalRuntime } from '../src/runtime/local.ts'
import { prepareGrantToken, type GrantPrincipal } from '../src/access/grants.ts'
import { assertReviewerRelease, releaseReviewerRequest } from '../src/releases/reviewer.ts'
import { CORE_VERSION } from '../src/capabilities.ts'

const source = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture() {
  const runtime = await LocalRuntime.open({ dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-release-reviewer-scope-')) })
  cleanup.push(() => runtime.close())
  const project = runtime.editProject({ operation: 'create', yaml: source, title: 'Reviewer projection', actor: 'fixture:author' })
  const release = runtime.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
    version: '1.0.0', actor: 'fixture:author', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
  const run = await runtime.runRelease(release.snapshot, { message: 'PRIVATE_REVIEW_REQUEST' }, { id: randomUUID() })
  if (run.state.status !== 'waiting') throw Error('expected waiting approval')
  const prepared = prepareGrantToken(randomUUID())
  const issued = await runtime.issueGrant({ id: prepared.id, tokenSha256: prepared.tokenSha256, actor: 'fixture:owner',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scope: { kind: 'reviewer', runId: run.id,
      revision: run.revision, attemptId: run.state.attempt.id, decisions: ['approve'] } })
  const principal: GrantPrincipal = { grantId: issued.id, actor: `grant:${issued.id}`, scope: issued.scope, expiresAt: issued.expiresAt }
  const pin = { id: release.snapshot.id, sha256: release.sha256, revision: run.revision, version: release.snapshot.version }
  return { runtime, run, principal, pin, token: prepared.token }
}

describe('exact-release reviewer projection', () => {
  it('returns only the currently assigned review, allowed action and immutable release identity', async () => {
    const { runtime, run, principal, pin } = await fixture()
    const view = releaseReviewerRequest(principal, await runtime.show(run.id), pin, ['approve', 'reject'])
    expect(view).toMatchObject({ schemaVersion: 1, release: pin, runId: run.id, nodeId: 'review', actions: ['approve'],
      review: { title: 'Review this request', input: 'PRIVATE_REVIEW_REQUEST' } })
    expect(Object.keys(view).sort()).toEqual(['schemaVersion', 'release', 'runId', 'attemptId', 'nodeId', 'expiresAt', 'actions', 'review'].sort())
    expect(JSON.stringify(view)).not.toContain('yaml')
    expect(JSON.stringify(view)).not.toContain('steps')
    expect(JSON.stringify(view)).not.toContain('tokenSha256')
    expect(JSON.stringify(view)).not.toContain('fixture:owner')
  })

  it('refuses foreign releases, runs, stale attempts, ungranted actions and elapsed waits', async () => {
    const { runtime, run, principal, pin } = await fixture(), retained = await runtime.show(run.id)
    if (principal.scope.kind !== 'reviewer') throw Error('fixture changed')
    const denied = (p: GrantPrincipal, r = retained, release = pin, actions = ['approve', 'reject'], at?: string) =>
      expect(() => releaseReviewerRequest(p, r, release, actions, at)).toThrowError(expect.objectContaining({ code: 'not-found' }))
    denied(principal, retained, { ...pin, id: randomUUID() })
    denied(principal, retained, { ...pin, sha256: 'b'.repeat(64) })
    denied(principal, { ...retained, id: randomUUID() })
    denied({ ...principal, scope: { ...principal.scope, attemptId: randomUUID() } })
    denied(principal, retained, pin, ['reject'])
    denied(principal, retained, pin, ['approve', 'reject'], principal.expiresAt)
    if (retained.state.status !== 'waiting') throw Error('fixture changed')
    denied(principal, retained, pin, ['approve', 'reject'], retained.state.expiresAt)
    expect(() => assertReviewerRelease({ ...principal, scope: { kind: 'caller', release: pin, permissions: ['read'] } }, retained, pin))
      .toThrowError(expect.objectContaining({ code: 'not-found' }))
  })

  it('does not reveal review input after the original attempt has been decided', async () => {
    const { runtime, run, principal, pin } = await fixture()
    if (run.state.status !== 'waiting') throw Error('fixture changed')
    await runtime.decide(run.id, run.state.attempt.id, 'approve', 'fixture:owner', { pauseAfter: true })
    const saved = await runtime.show(run.id)
    expect(() => releaseReviewerRequest(principal, saved, pin, ['approve', 'reject']))
      .toThrowError(expect.objectContaining({ code: 'not-found' }))
    expect(() => assertReviewerRelease(principal, saved, pin)).not.toThrow()
  })

  it('authenticates the exact release before allowing a trusted host to project the review', async () => {
    const { runtime, run, pin, token, principal } = await fixture()
    const selected = await runtime.reviewerReleaseWithGrant(token, pin)
    expect(selected.run.id).toBe(run.id)
    expect(selected.principal.grantId).toBe(principal.grantId)
    await expect(runtime.reviewerReleaseWithGrant(token, { ...pin, sha256: 'b'.repeat(64) }))
      .rejects.toMatchObject({ code: 'not-found' })
    await expect(runtime.reviewerReleaseWithGrant('invalid-token', pin)).rejects.toMatchObject({ code: 'not-found' })
    await runtime.revokeGrant({ id: principal.grantId, requestId: randomUUID(), expectedGeneration: 1, actor: 'fixture:owner' })
    await expect(runtime.reviewerReleaseWithGrant(token, pin)).rejects.toMatchObject({ code: 'not-found' })
  })
})
