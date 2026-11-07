import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, stat, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { unzipSync } from 'fflate'
import { LocalRuntime, prepareGrantToken, type GrantIssue } from '../src/runtime/index.ts'
import { grantTokenProof, grantMetadataSchema, grantPageResultSchema } from '../src/access/grants.ts'
import { CORE_VERSION, PROTOCOL_VERSION } from '../src/capabilities.ts'
import { createReleaseZip } from '../src/packages/release-zip.ts'
import { createProjectZip } from '../src/packages/project-zip.ts'
import { dispatchOperation } from '../src/http/operations.ts'
import { operationCapabilities } from '../src/http/operation-host.ts'
import { startRuntimeService } from '../src/http/service.ts'
import { PreviewSession } from '../src/preview/session.ts'
import { ReleaseSession } from '../src/releases/service-session.ts'
import { main } from '../src/cli.ts'

const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const at = '2026-10-02T00:00:00.000Z', expiresAt = '2026-10-03T00:00:00.000Z'
const artifactBytes = Buffer.from('Fixture runtime; not executable qualification')
const artifact = { storage: 'sqlite' as const, bytes: artifactBytes, notices: Buffer.from('Fixture notice'),
  identity: { version: CORE_VERSION, sha256: createHash('sha256').update(artifactBytes).digest('hex') } }
const owners: LocalRuntime[] = [], cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); for (const owner of owners.splice(0)) await owner.close() })
async function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at)
  const directory = await mkdtemp(join(tmpdir(), 'jevable-grant-runtime-'))
  const owner = await LocalRuntime.open({ dataDirectory: join(directory, 'state') }); owners.push(owner)
  const project = owner.editProject({ operation: 'create', yaml: echo, title: 'Caller fixture', actor: 'owner:fixture' })
  const release = owner.createRelease({ projectId: project.id, expectedGeneration: 1, revision: project.acceptedRevision,
    version: '1.0.0', actor: 'owner:fixture', runtime: artifact.identity })
  const prepared = prepareGrantToken(randomUUID()), command: GrantIssue = { id: prepared.id, tokenSha256: prepared.tokenSha256,
    actor: 'owner:fixture', expiresAt, scope: { kind: 'caller', release: { id: release.snapshot.id, sha256: release.sha256,
      revision: project.acceptedRevision }, permissions: ['read', 'start'] } }
  return { directory, owner, project, release, prepared, command }
}
async function cli(...args: string[]) {
  let out = '', err = ''
  const exit = await main(args, { out: value => { out += value }, err: value => { err += value } })
  return { exit, out: out ? JSON.parse(out) : undefined, err: err ? JSON.parse(err) : undefined }
}
async function requestFile(f: Awaited<ReturnType<typeof fixture>>, command = f.command) {
  const { actor: _actor, ...request } = command, path = join(f.directory, `request-${randomUUID()}.json`)
  await writeFile(path, JSON.stringify(request), { mode: 0o600 }); return path
}

describe('standalone owner SDK grant lifecycle', () => {
  it('pins a retained release without running it; survives reopen and preserves exact replay/revocation history', async () => {
    const f = await fixture(), before = f.owner.list(), issued = await f.owner.issueGrant(f.command)
    expect(issued).toMatchObject({ id: f.prepared.id, generation: 1, status: 'active', scope: f.command.scope })
    expect(grantMetadataSchema.parse(issued)).toEqual(issued); expect(f.owner.list()).toEqual(before)
    await f.owner.close()
    const reopened = await LocalRuntime.open({ dataDirectory: join(f.directory, 'state') }); owners.push(reopened)
    expect(reopened.grant(issued.id)).toEqual(issued)
    const revoke = { id: issued.id, requestId: randomUUID(), expectedGeneration: 1 as const, actor: 'owner:revoke' }
    expect(await reopened.revokeGrant(revoke)).toMatchObject({ status: 'revoked', generation: 2 })
    vi.setSystemTime(expiresAt)
    expect(await reopened.issueGrant(f.command)).toMatchObject({ status: 'revoked', generation: 2 })
    expect(await reopened.revokeGrant(revoke)).toMatchObject({ status: 'revoked', generation: 2 })
    expect(reopened.list()).toEqual(before)
    const db = new DatabaseSync(join(f.directory, 'state/runtime.sqlite'), { readOnly: true })
    try { expect(db.prepare('SELECT count(*) AS n FROM access_grant_events').get()!.n).toBe(2)
      expect(JSON.stringify(db.prepare('SELECT * FROM access_grants').all())).not.toContain(f.prepared.token) }
    finally { db.close() }
  })
  it.each(['foreign-release', 'changed-hash', 'changed-revision', 'expired'] as const)('refuses %s issuance without a grant or run', async kind => {
    const f = await fixture(), value = structuredClone(f.command)
    if (value.scope.kind !== 'caller') throw Error('fixture caller')
    if (kind === 'foreign-release') value.scope.release.id = randomUUID()
    if (kind === 'changed-hash') value.scope.release.sha256 = 'c'.repeat(64)
    if (kind === 'changed-revision') value.scope.release.revision = 'd'.repeat(64)
    if (kind === 'expired') value.expiresAt = at
    await expect(f.owner.issueGrant(value)).rejects.toHaveProperty('code', kind === 'foreign-release' ? 'not-found' : kind === 'expired' ? 'invalid-command' : 'conflict')
    expect(f.owner.grants().grants).toEqual([]); expect(f.owner.list()).toEqual([])
  })
  it('issues only for the current exact approval attempt; issuing/revoking neither decides nor changes run evidence', async () => {
    const f = await fixture(), run = await f.owner.run(approval, { message: 'PRIVATE_REVIEW' })
    if (run.state.status !== 'waiting') throw Error('fixture wait')
    const before = await f.owner.events(run.id), prepared = prepareGrantToken(randomUUID()), command: GrantIssue = { id: prepared.id, tokenSha256: prepared.tokenSha256,
      expiresAt, actor: 'owner:fixture', scope: { kind: 'reviewer', runId: run.id, attemptId: run.state.attempt.id, revision: run.revision, decisions: ['approve'] } }
    expect(await f.owner.issueGrant(command)).toMatchObject({ scope: command.scope, status: 'active' })
    expect(await f.owner.events(run.id)).toEqual(before); expect(await f.owner.show(run.id)).toEqual(run)
    await f.owner.revokeGrant({ id: prepared.id, requestId: randomUUID(), expectedGeneration: 1, actor: 'owner:fixture' })
    expect(await f.owner.events(run.id)).toEqual(before)
    await f.owner.decide(run.id, run.state.attempt.id, 'approve', 'owner:fixture')
    // Exact replay observes the old revoked grant, never grants access to another wait.
    expect(await f.owner.issueGrant(command)).toMatchObject({ status: 'revoked' })
    const next = prepareGrantToken(randomUUID())
    await expect(f.owner.issueGrant({ ...command, id: next.id, tokenSha256: next.tokenSha256 })).rejects.toHaveProperty('code', 'conflict')
  })
  it('refuses an action absent from the live approval node before issuing a direct SDK grant', async () => {
    const f = await fixture(), run = await f.owner.run(approval, { message: 'PRIVATE_REVIEW' })
    if (run.state.status !== 'waiting') throw Error('fixture wait')
    const p = prepareGrantToken(randomUUID()), events = await f.owner.events(run.id)
    await expect(f.owner.issueGrant({ id: p.id, tokenSha256: p.tokenSha256, actor: 'owner:fixture', expiresAt,
      scope: { kind: 'reviewer', runId: run.id, attemptId: run.state.attempt.id, revision: run.revision,
        decisions: ['requestChanges'] } })).rejects.toHaveProperty('code', 'invalid-command')
    expect(f.owner.grants().grants).toEqual([])
    expect(await f.owner.events(run.id)).toEqual(events)
  })
  it.each(['foreign-run', 'stale-attempt', 'stale-revision', 'expired-wait', 'cancelled'] as const)('refuses %s reviewer pins without mutation', async kind => {
    const f = await fixture(), run = await f.owner.run(approval, { message: 'PRIVATE_REVIEW' })
    if (run.state.status !== 'waiting') throw Error('fixture wait')
    if (kind === 'cancelled') f.owner.cancel(run.id, randomUUID(), 'owner:fixture')
    if (kind === 'expired-wait') vi.setSystemTime('2026-10-04T00:00:00.000Z')
    const before = await f.owner.events(run.id), p = prepareGrantToken(randomUUID())
    await expect(f.owner.issueGrant({ id: p.id, tokenSha256: p.tokenSha256, actor: 'owner:fixture', expiresAt: '2026-10-05T00:00:00.000Z',
      scope: { kind: 'reviewer', runId: kind === 'foreign-run' ? randomUUID() : run.id, attemptId: kind === 'stale-attempt' ? randomUUID() : run.state.attempt.id,
        revision: kind === 'stale-revision' ? 'b'.repeat(64) : run.revision, decisions: ['approve', 'reject'] } }))
      .rejects.toHaveProperty('code', kind === 'foreign-run' ? 'not-found' : 'conflict')
    expect(f.owner.grants().grants).toEqual([]); expect(await f.owner.events(run.id)).toEqual(before)
  })
  it('keeps installations separate and excludes grant records/digests/bearers from project/release ZIPs', async () => {
    const f = await fixture(), other = await fixture(); await f.owner.issueGrant(f.command)
    expect(other.owner.grants().grants).toEqual([])
    expect(() => other.owner.grant(f.prepared.id)).toThrowError(expect.objectContaining({ code: 'not-found' }))
    await expect(other.owner.issueGrant(f.command)).rejects.toHaveProperty('code', 'not-found')
    const bundle = f.owner.exportProject(f.project.id, 1, f.project.acceptedRevision, true, true)
    for (const value of [bundle, f.release]) {
      expect(JSON.stringify(value)).not.toContain(f.prepared.id); expect(JSON.stringify(value)).not.toContain(f.prepared.tokenSha256)
    }
    const archives = [createReleaseZip(f.release, artifact), createProjectZip(bundle)]
    for (const archive of archives) for (const [name, data] of Object.entries(unzipSync(archive))) {
      expect(name).not.toMatch(/grant/); expect(Buffer.from(data).toString()).not.toContain(f.prepared.token)
      expect(Buffer.from(data).toString()).not.toContain(f.prepared.tokenSha256)
    }
    await f.owner.close()
    await expect(f.owner.issueGrant(f.command)).rejects.toHaveProperty('code', 'closed')
    expect(() => f.owner.grant(f.prepared.id)).toThrowError(expect.objectContaining({ code: 'closed' }))
  })
  it('migrates a real schema-16 database additively without changing retained run/project evidence', async () => {
    const f = await fixture(), run = await f.owner.run(echo, 'migration'), before = await f.owner.events(run.id)
    await f.owner.close()
    const db = new DatabaseSync(join(f.directory, 'state/runtime.sqlite'))
    try { db.exec('DROP TABLE access_grant_events; DROP TABLE access_grants; PRAGMA user_version=16') } finally { db.close() }
    const reopened = await LocalRuntime.open({ dataDirectory: join(f.directory, 'state') }); owners.push(reopened)
    expect(await reopened.show(run.id)).toEqual(run); expect(await reopened.events(run.id)).toEqual(before)
    expect(reopened.project(f.project.id)).toEqual(f.project); expect(reopened.grants().grants).toEqual([])
    expect(await reopened.issueGrant(f.command)).toMatchObject({ generation: 1 })
  })
  it.each(['missing-table', 'changed-audit'])('refuses schema-17 %s before exposing retained workflows; does not repair', async kind => {
    const f = await fixture(); await f.owner.issueGrant(f.command); await f.owner.close()
    const db = new DatabaseSync(join(f.directory, 'state/runtime.sqlite'))
    try { if (kind === 'missing-table') db.exec('DROP TABLE access_grant_events')
      else db.exec("UPDATE access_grant_events SET kind='grant-revoked'") } finally { db.close() }
    await expect(LocalRuntime.open({ dataDirectory: join(f.directory, 'state') })).rejects.toHaveProperty('code', 'corrupt')
    const inspect = new DatabaseSync(join(f.directory, 'state/runtime.sqlite'), { readOnly: true })
    try { if (kind === 'missing-table') expect(inspect.prepare("SELECT name FROM sqlite_master WHERE name='access_grant_events'").all()).toEqual([])
      else expect(inspect.prepare('SELECT kind FROM access_grant_events').get()!.kind).toBe('grant-revoked') } finally { inspect.close() }
  })
})

describe('grant administration boundaries and CLI', () => {
  it.each(['sqlite', 'postgres'] as const)('uses strict %s management operations and a fixed host actor, not submitted attribution', async storage => {
    const f = await fixture(), { actor: _actor, ...command } = f.command
    // PostgreSQL dispatch contract uses an awaitable host; real SQL is a separate qualification gate.
    const target = { storage, runtime: f.owner } as Parameters<typeof dispatchOperation>[0]
    const issued = await dispatchOperation(target, { operation: 'grants.issue', command }, 'service:owner')
    expect(issued).toMatchObject({ issuer: 'service:owner', generation: 1 })
    for (const change of [{ actor: 'spoof' }, { token: f.prepared.token }, { execute: true }])
      await expect(dispatchOperation(target, { operation: 'grants.issue', command: { ...command, ...change } }, 'service:owner')).rejects.toHaveProperty('code', 'invalid-command')
    await expect(dispatchOperation(target, { operation: 'grants.list' }, 'service:owner')).rejects.toHaveProperty('code', 'invalid-command')
    const revocation = { id: f.prepared.id, requestId: randomUUID(), expectedGeneration: 1 }
    await expect(dispatchOperation(target, { operation: 'grants.revoke', command: { ...revocation, actor: 'spoof' } }, 'service:owner')).rejects.toHaveProperty('code', 'invalid-command')
    expect(await dispatchOperation(target, { operation: 'grants.revoke', command: revocation }, 'service:owner')).toMatchObject({ revocation: { actor: 'service:owner' } })
    expect(await dispatchOperation(target, { operation: 'grants.show', id: f.prepared.id }, 'service:owner')).toMatchObject({ status: 'revoked' })
    const page = await dispatchOperation(target, { operation: 'grants.list', page: { limit: 1 } }, 'service:owner')
    expect(grantPageResultSchema.parse(page).grants).toHaveLength(1)
    expect(operationCapabilities(storage).delegatedGrants).toMatchObject({ delegatedHttpAuthentication: false, delegatedExecution: false })
  })
  it('does not widen project-scoped preview or exact-release authority for grant administration', async () => {
    const f = await fixture(), { actor: _actor, ...command } = f.command
    const preview = await PreviewSession.create({ call: value => dispatchOperation({ storage: 'sqlite', runtime: f.owner }, value, 'owner:preview') }, echo)
    const release = new ReleaseSession({ storage: 'sqlite', runtime: f.owner }, f.release.snapshot, 'owner:release')
    for (const value of [{ operation: 'grants.issue', command }, { operation: 'grants.show', id: f.prepared.id }, { operation: 'grants.list', page: {} }]) {
      await expect(preview.operation(value)).rejects.toHaveProperty('code', 'invalid-command')
      await expect(release.operation(value)).rejects.toHaveProperty('code', 'invalid-command')
    }
    expect(f.owner.grants().grants).toEqual([])
  })
  it('prepares an owner-only token file offline without displaying or overwriting it; issue files reject actor/bearer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-grant-cli-')), id = randomUUID(), path = join(directory, 'token')
    const prepared = await cli('grants', 'token', '--id', id, '--output', path)
    const token = (await readFile(path, 'utf8')).trim()
    expect(prepared.exit).toBe(0); expect(prepared.out).toMatchObject({ id, status: 'prepared-not-issued', tokenSha256: grantTokenProof(token)!.tokenSha256 })
    expect(JSON.stringify(prepared)).not.toContain(token); if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await cli('grants', 'token', '--id', id, '--output', path)).exit).toBe(1); expect((await readFile(path, 'utf8')).trim()).toBe(token)
    expect((await cli('grants', 'token', '--id', id, '--output', path, '--overwrite')).exit).toBe(2)
    const f = await fixture()
    for (const extra of [{ actor: 'spoof' }, { token }, { owner: true }]) {
      const request = await requestFile(f), json = JSON.parse(await readFile(request, 'utf8')); await writeFile(request, JSON.stringify({ ...json, ...extra }))
      const invalid = await cli('grants', 'issue', request, '--data-dir', join(directory, 'must-not-open'))
      expect(invalid.exit).toBe(2); expect(JSON.stringify(invalid)).not.toContain(token)
      await expect(stat(join(directory, 'must-not-open'))).rejects.toHaveProperty('code', 'ENOENT')
    }
    const link = join(directory, 'link'); await symlink(path, link)
    expect((await cli('grants', 'token', '--id', randomUUID(), '--output', link)).exit).toBe(1)
    expect((await readFile(path, 'utf8')).trim()).toBe(token)
  })
  it('retains a digest-only CLI command for exact issue/show/page/revoke/reopen without execution', async () => {
    const f = await fixture(), request = await requestFile(f), data = join(f.directory, 'state'); await f.owner.close()
    const issued = await cli('grants', 'issue', request, '--data-dir', data); expect(issued.exit, JSON.stringify(issued.err)).toBe(0)
    expect(issued.out).toMatchObject({ id: f.prepared.id, generation: 1 })
    expect((await cli('grants', 'show', f.prepared.id, '--data-dir', data)).out).toEqual(issued.out)
    expect((await cli('grants', 'list', '--page', '--limit', '1', '--data-dir', data)).out.grants).toEqual([issued.out])
    expect((await cli('grants', 'list', '--data-dir', join(f.directory, 'must-not-open'))).exit).toBe(2)
    expect((await cli('grants', 'revoke', f.prepared.id, '--request-id', randomUUID(), '--expected-generation', '2', '--data-dir', data)).exit).toBe(2)
    const id = randomUUID(), revoked = await cli('grants', 'revoke', f.prepared.id, '--request-id', id, '--expected-generation', '1', '--data-dir', data)
    expect(revoked.exit).toBe(0); expect(revoked.out).toMatchObject({ status: 'revoked', generation: 2 })
    expect((await cli('grants', 'revoke', f.prepared.id, '--request-id', id, '--expected-generation', '1', '--data-dir', data)).out).toEqual(revoked.out)
    expect((await cli('grants', 'issue', request, '--data-dir', data)).out.status).toBe('revoked')
    const reopened = await LocalRuntime.open({ dataDirectory: data }); owners.push(reopened); expect(reopened.list()).toEqual([])
    expect(JSON.stringify([issued, revoked])).not.toContain(f.prepared.tokenSha256)
  })
  it('keeps prepared/issued delegated tokens unauthorized on owner routes; API actor and expiry are retained', async () => {
    const f = await fixture(); await f.owner.close(); vi.useRealTimers()
    const token = randomBytes(32).toString('hex'), service = await startRuntimeService({ runtime: { dataDirectory: join(f.directory, 'state') }, token, actor: 'service:owner' })
    cleanup.push(async () => { await service.close(); await service.closed })
    const call = (value: unknown, secret = token) => fetch(service.url + '/v1/operations', { method: 'POST', headers: {
      Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'X-Jevable-Protocol': PROTOCOL_VERSION, 'X-Jevable-Instance': service.instanceId }, body: JSON.stringify(value) })
    const { actor: _actor, ...command } = { ...f.command, expiresAt: new Date(Date.now() + 3600000).toISOString() }
    const denied = await call({ operation: 'grants.issue', command }, f.prepared.token); expect(denied.status).toBe(401)
    expect(JSON.stringify(await denied.json())).not.toContain(f.prepared.token)
    const response = await call({ operation: 'grants.issue', command }); expect(response.status).toBe(200)
    expect((await response.json() as any).result).toMatchObject({ issuer: 'service:owner', generation: 1 })
    for (const operation of [{ operation: 'grants.show', id: command.id }, { operation: 'runs.start', id: randomUUID(), yaml: echo, input: 'must not run' }])
      expect((await call(operation, f.prepared.token)).status).toBe(401)
    expect((await (await call({ operation: 'runs.list' })).json() as any).result.runs).toEqual([])
    expect((await call({ operation: 'grants.issue', command: { ...command, actor: 'spoof' } })).status).toBe(400)
  })
  it('rejects secret-bearing or inconsistent metadata responses before CLI display', async () => {
    const f = await fixture(), metadata = await f.owner.issueGrant(f.command)
    for (const change of [{ token: f.prepared.token }, { tokenSha256: f.prepared.tokenSha256 }, { status: 'revoked' }, { generation: 2 }])
      expect(grantMetadataSchema.safeParse({ ...metadata, ...change }).success).toBe(false)
    expect(grantPageResultSchema.safeParse({ schemaVersion: 1, observedAt: at, grants: [metadata], nextCursor: randomUUID() }).success).toBe(false)
    expect(grantPageResultSchema.safeParse({ schemaVersion: 1, observedAt: expiresAt, grants: [metadata], nextCursor: null }).success).toBe(false)
  })
})
