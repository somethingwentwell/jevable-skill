import { afterEach, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalRuntime } from '../src/runtime/local.ts'
import { startRuntimeService } from '../src/http/service.ts'
import { ReleaseClient } from '../src/releases/client.ts'
import { prepareGrantToken } from '../src/access/grants.ts'
import { CORE_VERSION, PROTOCOL_VERSION } from '../src/capabilities.ts'

const source = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture(reviewerDecisions = true, seedForeign = false, workflow = source) {
  const author = await LocalRuntime.open({ dataDirectory: await mkdtemp(join(tmpdir(), 'jevable-release-reviewer-author-')) })
  let release, foreign
  try {
    const project = author.editProject({ operation: 'create', yaml: workflow, title: 'Reviewer host', actor: 'fixture:author' })
    release = author.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
      version: '1.0.0', actor: 'fixture:author', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
    foreign = author.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
      version: '2.0.0', actor: 'fixture:author', runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
  } finally { await author.close() }
  const dataDirectory = await mkdtemp(join(tmpdir(), 'jevable-release-reviewer-host-'))
  let foreignGrant, foreignRun
  if (seedForeign) {
    const runtime = await LocalRuntime.open({ dataDirectory })
    try {
      foreignRun = await runtime.runRelease(foreign.snapshot, { message: 'PRIVATE_FOREIGN_REVIEW' }, { id: randomUUID() })
      if (foreignRun.state.status !== 'waiting') throw Error('fixture changed')
      foreignGrant = prepareGrantToken(randomUUID())
      await runtime.issueGrant({ id: foreignGrant.id, tokenSha256: foreignGrant.tokenSha256,
        scope: { kind: 'reviewer', runId: foreignRun.id, attemptId: foreignRun.state.attempt.id,
          revision: foreignRun.revision, decisions: ['approve'] }, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), actor: 'fixture:author' })
    } finally { await runtime.close() }
  }
  const ownerToken = randomBytes(32).toString('hex')
  const service = await startRuntimeService({ runtime: { dataDirectory },
    token: ownerToken, actor: 'fixture:service-owner', release: { snapshot: release.snapshot }, reviewerDecisions })
  cleanup.push(() => service.close())
  const client = new ReleaseClient(service.url, ownerToken, release.sha256)
  const owner = async (command: Record<string, unknown>) => (await client.operation(command as never) as { result: any }).result
  const grant = prepareGrantToken(randomUUID())
  const delegated = (path: string, token = grant.token, value: unknown = {}, headers: Record<string, string> = {}) =>
    fetch(service.url + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json', 'X-Jevable-Protocol': PROTOCOL_VERSION,
      'X-Jevable-Instance': service.instanceId, ...headers }, body: JSON.stringify(value) })
  return { release, foreign, foreignGrant, foreignRun, ownerToken, service, client, owner, grant, delegated }
}

describe('opt-in exact-release reviewer transport', () => {
  it('delegates a custom named action only when the exact node and grant both allow it, then replays its saved receipt', async () => {
    const custom = source.replace('actions: [approve, reject]', 'actions: [approve, reject, requestChanges]')
      .replace('    - from: review\n      port: approve\n      to: result',
        '    - from: review\n      port: approve\n      to: result\n    - from: review\n      port: requestChanges\n      to: result')
    const f = await fixture(true, false, custom)
    const run = await f.owner({ operation: 'runs.start', id: randomUUID(), input: { message: 'PRIVATE_CHANGE_REQUEST' } })
    const issue = { operation: 'reviewers.issue', id: f.grant.id, tokenSha256: f.grant.tokenSha256,
      runId: run.id, attemptId: run.attemptId, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), decisions: ['requestChanges'] }
    await expect(f.owner({ ...issue, decisions: ['timeout'] })).rejects.toHaveProperty('code', 'invalid-command')
    await expect(f.owner({ ...issue, decisions: ['escalate'] })).rejects.toHaveProperty('code', 'invalid-command')
    await f.owner(issue)
    const shown = await f.delegated('/v1/reviewer/request')
    expect(shown.status).toBe(200)
    expect((await shown.json() as any).result.actions).toEqual(['requestChanges'])
    const denied = await f.delegated('/v1/reviewer/decisions', f.grant.token, { requestId: randomUUID(), action: 'approve' })
    expect(denied.status).toBe(404)
    const choice = { requestId: randomUUID(), action: 'requestChanges', pauseAfter: true }
    const first = await f.delegated('/v1/reviewer/decisions', f.grant.token, choice)
    expect(first.status).toBe(200)
    const saved = await first.json() as any
    expect(saved.result).toMatchObject({ action: 'requestChanges', requestId: choice.requestId, runId: run.id, status: 'paused' })
    expect(await (await f.delegated('/v1/reviewer/decisions', f.grant.token, choice)).json()).toEqual(saved)
    expect(JSON.stringify(saved)).not.toContain('PRIVATE_CHANGE_REQUEST')
  })
  it('shows only the assigned review and commits/retries one approved decision without owner access', async () => {
    const f = await fixture()
    const caps: any = await f.client.capabilities()
    expect(caps.api.endpoints).toContain('/review')
    expect(caps.api.endpoints).toContain('/v1/reviewer/request')
    expect(caps.api.endpoints).toContain('/v1/reviewer/decisions')
    expect(caps.reviewerAccess).toMatchObject({ enabled: true, scope: 'one-release-one-run-one-attempt', ownerTokenShared: false })
    const spec = await (await fetch(f.service.url + '/v1/openapi.json', { headers: { Authorization: `Bearer ${f.ownerToken}` } })).json() as any
    expect(spec.paths['/v1/reviewer/request'].post.security).toEqual([{ reviewerBearer: [] }])
    expect(spec.paths['/v1/reviewer/decisions'].post.security).toEqual([{ reviewerBearer: [] }])
    expect(spec.paths['/v1/operations'].post.security).toBeUndefined()
    const page = await fetch(f.service.url + '/review')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(page.headers.get('cache-control')).toBe('no-store')
    const shell = await page.text()
    expect(shell).toContain('Review a request')
    expect(shell).not.toContain(f.ownerToken)
    expect(shell).not.toContain(f.grant.token)
    expect(shell).not.toContain(f.release.sha256)
    const run = await f.owner({ operation: 'runs.start', id: randomUUID(), input: { message: 'PRIVATE_REVIEW' } })
    expect(run.status).toBe('waiting')
    const issue = { operation: 'reviewers.issue', id: f.grant.id, tokenSha256: f.grant.tokenSha256,
      runId: run.id, attemptId: run.attemptId, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), decisions: ['approve'] }
    const metadata = await f.owner(issue)
    expect(metadata).toMatchObject({ id: f.grant.id, scope: { kind: 'reviewer', runId: run.id, attemptId: run.attemptId,
      revision: run.revision, decisions: ['approve'] }, status: 'active' })
    expect(JSON.stringify(metadata)).not.toContain('tokenSha256')
    expect(JSON.stringify(metadata)).not.toContain(f.grant.token)
    expect((await f.owner({ operation: 'reviewers.show', id: f.grant.id })).id).toBe(f.grant.id)

    const shown = await f.delegated('/v1/reviewer/request')
    expect(shown.status).toBe(200)
    const request = await shown.json() as any
    expect(request).toMatchObject({ instanceId: f.service.instanceId,
      result: { release: { id: f.release.snapshot.id, sha256: f.release.sha256 }, runId: run.id,
        attemptId: run.attemptId, actions: ['approve'], review: { title: 'Review this request', input: 'PRIVATE_REVIEW' } } })
    expect(Object.keys(request.result).sort()).toEqual(['schemaVersion', 'release', 'runId', 'attemptId', 'nodeId', 'expiresAt', 'actions', 'review'].sort())
    for (const privateValue of ['yaml', 'steps', 'tokenSha256', 'fixture:service-owner'])
      expect(JSON.stringify(request)).not.toContain(privateValue)
    expect((await f.delegated('/v1/operations', f.grant.token, { operation: 'runs.list' })).status).toBe(401)
    expect((await f.delegated('/v1/reviewer/request', f.ownerToken)).status).toBe(401)
    expect((await f.delegated('/v1/reviewer/request', f.grant.token, {}, { 'X-Jevable-Instance': randomUUID() })).status).toBe(409)
    expect((await f.delegated('/v1/reviewer/request', f.grant.token, {}, { Origin: 'https://foreign.example' })).status).toBe(403)
    expect((await f.delegated('/v1/reviewer/request', f.grant.token, { runId: run.id })).status).toBe(400)

    const decision = { requestId: randomUUID(), action: 'approve', pauseAfter: true }
    const committed = await f.delegated('/v1/reviewer/decisions', f.grant.token, decision)
    expect(committed.status).toBe(200)
    const receipt = await committed.json() as any
    expect(receipt.result).toMatchObject({ requestId: decision.requestId, runId: run.id, attemptId: run.attemptId,
      action: 'approve', status: 'paused' })
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_REVIEW')
    expect((await f.delegated('/v1/reviewer/request')).status).toBe(404)
    expect(await (await f.delegated('/v1/reviewer/decisions', f.grant.token, decision)).json()).toEqual(receipt)
    expect((await f.owner(issue)).id).toBe(f.grant.id)
    const revoked = await f.owner({ operation: 'reviewers.revoke', id: f.grant.id, requestId: randomUUID(), expectedGeneration: 1 })
    expect(revoked.status).toBe('revoked')
    expect((await f.delegated('/v1/reviewer/decisions', f.grant.token, decision)).status).toBe(404)
  })

  it('keeps reviewer routes off by default', async () => {
    const f = await fixture(false)
    const caps: any = await f.client.capabilities()
    expect(caps.api.endpoints).not.toContain('/review')
    expect(caps.api.endpoints).not.toContain('/v1/reviewer/request')
    expect(caps.api.endpoints).not.toContain('/v1/reviewer/decisions')
    expect((await f.delegated('/v1/reviewer/request')).status).toBe(401)
    expect((await fetch(f.service.url + '/review')).status).toBe(401)
  })

  it('refuses a live grant and owner administration belonging to a different immutable release', async () => {
    const f = await fixture(true, true)
    expect(f.foreignGrant).toBeDefined(); expect(f.foreignRun?.state.status).toBe('waiting')
    expect((await f.delegated('/v1/reviewer/request', f.foreignGrant!.token)).status).toBe(404)
    expect((await f.delegated('/v1/reviewer/decisions', f.foreignGrant!.token,
      { requestId: randomUUID(), action: 'approve', pauseAfter: true })).status).toBe(404)
    await expect(f.owner({ operation: 'reviewers.show', id: f.foreignGrant!.id })).rejects.toHaveProperty('code', 'not-found')
    await expect(f.owner({ operation: 'reviewers.revoke', id: f.foreignGrant!.id, requestId: randomUUID(), expectedGeneration: 1 }))
      .rejects.toHaveProperty('code', 'not-found')
    await expect(f.owner({ operation: 'reviewers.issue', id: randomUUID(), tokenSha256: f.grant.tokenSha256,
      runId: f.foreignRun!.id, attemptId: (f.foreignRun!.state as { attempt: { id: string } }).attempt.id,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), decisions: ['approve'] }))
      .rejects.toHaveProperty('code', 'not-found')
  })
})
