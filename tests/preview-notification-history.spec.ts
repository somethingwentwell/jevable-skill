import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { runInNewContext, Script } from 'node:vm'
import { createPreview, projectPreviewNotificationHistory } from '../src/preview/index.ts'
import { liveNotificationHistoryControls, notificationHistoryHtml } from '../src/preview/notification-history-controls.ts'
import { renderLivePage } from '../src/preview/live-page.ts'
import { PreviewSession } from '../src/preview/session.ts'
import { inspectProjectNotificationPage, type ProjectNotificationPage } from '../src/notifications/project-history.ts'
import { startRuntimeService, startPreviewGateway, RuntimeClient, type RuntimeOperation } from '../src/http/index.ts'
import { PROTOCOL_VERSION } from '../src/capabilities.ts'
import { createTlsFixture, fixturePort } from '../scripts/tls-fixture.mjs'
import type { NotificationFilter } from '../src/notifications/history.ts'

const source = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const preview = createPreview(source)
if (!preview.revision) throw Error('Fixture workflow is invalid')
const project = { id: randomUUID(), generation: 1, revision: preview.revision }
const id = (i: number) => i.toString(16).padStart(8, '0') + '-0000-4000-8000-000000000000'
const at = '2026-10-06T00:00:00.000Z'
function page(count = 1, offset = 0, more = false): ProjectNotificationPage {
  return { schemaVersion: 1, project: { ...project }, deliveries: Array.from({ length: count }, (_, i) => ({
    request: { requestId: id(offset + i + 1), runId: randomUUID(), revision: project.revision, attemptId: randomUUID(),
      endpointId: 'review', endpointSha256: 'a'.repeat(64), eventSha256: 'b'.repeat(64) }, createdAt: at, outcome: { status: 'pending' } })),
    nextCursor: more ? id(offset + count) : null, order: 'request-id-ascending', consistency: 'live-keyset; not-a-snapshot',
    semantics: 'pending-is-not-proof-of-dispatch; HTTP-acceptance-is-not-human-delivery-or-approval' }
}
function filteredPage(filter: NotificationFilter, count = 1, offset = 0, more = false) {
  const value = page(count, offset, more); value.filter = { ...filter }
  for (const row of value.deliveries) {
    if (filter.eventKind && filter.eventKind !== 'requested') row.request.eventKind = filter.eventKind
    if (filter.outcome && filter.outcome !== 'pending') row.outcome = { status: 'settled', at,
      result: filter.outcome === 'uncertain' ? { status: 'uncertain', reason: 'transport' }
        : { status: filter.outcome, httpStatus: filter.outcome === 'accepted' ? 202 : 409 } }
  }
  return value
}
const invalidFilters = [{}, null, { outcome: 'settled' }, { eventKind: 'approved' }, { actor: 'PRIVATE_ACTOR' },
  { createdFrom: '2026-10-06T00:00:00Z' }, { createdFrom: '2026-02-30T00:00:00.000Z' },
  { createdBefore: '2026-10-06T00:00:00.000+00:00' }, { createdFrom: at, createdBefore: at },
  { createdFrom: '2026-10-07T00:00:00.000Z', createdBefore: at }, { outcome: undefined }]
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

describe('serialized project notification metadata admission', () => {
  it.each(['pending', 'accepted', 'rejected', 'uncertain'].flatMap(outcome =>
    ['requested', 'decided', 'expired', 'cancelled'].map(eventKind => ({ outcome, eventKind }))))(
    'admits matching outcome/lifecycle filters and exact half-open time bounds: %j', selection => {
      const filter = { ...selection, createdFrom: at, createdBefore: '2026-10-06T00:00:00.001Z' } as NotificationFilter
      const value = filteredPage(filter), request = { filter, limit: 1 }, original = JSON.stringify(value)
      const expected = inspectProjectNotificationPage(value, project, request)
      expect(projectPreviewNotificationHistory(project, request, value)).toEqual(expected)
      expect(runInNewContext(`(${projectPreviewNotificationHistory.toString()})(scope, request, value)`,
        { scope: project, request, value })).toEqual(expected)
      expect(JSON.stringify(value)).toBe(original)
    })
  it.each(invalidFilters)('refuses invalid filter selection before metadata admission: %j', filter => {
    expect(() => projectPreviewNotificationHistory(project, { filter } as never, page())).toThrow()
  })
  it.each(['omitted-echo', 'changed-echo', 'wrong-outcome', 'wrong-kind', 'outside-range'])('refuses mismatching filter replies: %s', fault => {
    const filter = { outcome: 'pending' as const, eventKind: 'requested' as const, createdFrom: at }
    const value = filteredPage(filter)
    if (fault === 'omitted-echo') delete value.filter
    if (fault === 'changed-echo') value.filter = { outcome: 'accepted' }
    if (fault === 'wrong-outcome') value.deliveries[0]!.outcome = { status: 'settled', at, result: { status: 'accepted', httpStatus: 202 } }
    if (fault === 'wrong-kind') value.deliveries[0]!.request.eventKind = 'decided'
    if (fault === 'outside-range') value.deliveries[0]!.createdAt = '2026-10-05T23:59:59.999Z'
    expect(() => projectPreviewNotificationHistory(project, { filter }, value)).toThrow()
  })
  it('normalizes optional undefined keys, preserves omission, and refuses unsolicited filters', () => {
    const value = filteredPage({ outcome: 'pending' })
    expect(projectPreviewNotificationHistory(project, { filter: { outcome: 'pending', eventKind: undefined } }, value)).toEqual(value)
    expect(projectPreviewNotificationHistory(project, {}, page())).not.toHaveProperty('filter')
    expect(() => projectPreviewNotificationHistory(project, {}, value)).toThrow()
    expect(() => projectPreviewNotificationHistory(project, { filter: { createdBefore: at } }, { ...page(), filter: { createdBefore: at } })).toThrow()
  })
  it('matches core admission and serializes without imports, private bodies or mutation', () => {
    const value = page(2), original = JSON.stringify(value)
    const expected = inspectProjectNotificationPage(value, project, { limit: 2 })
    expect(projectPreviewNotificationHistory(project, { limit: 2 }, value)).toEqual(expected)
    expect(runInNewContext(`(${projectPreviewNotificationHistory.toString()})(scope, request, value)`,
      { scope: project, request: { limit: 2 }, value })).toEqual(expected)
    expect(JSON.stringify(value)).toBe(original)
    expect(projectPreviewNotificationHistory(project, {}, page(0))).toMatchObject({ deliveries: [], nextCursor: null })
  })
  it.each(['accepted', 'rejected', 'uncertain'] as const)('preserves recorded %s outcomes without treating them as delivery or approval', status => {
    const value = page(), row = value.deliveries[0]!
    row.outcome = { status: 'settled', at, result: status === 'uncertain' ? { status, reason: 'timeout' }
      : { status, httpStatus: status === 'accepted' ? 202 : 503 } }
    row.request.eventKind = 'decided'; row.request.redeliverOf = id(0)
    const result = projectPreviewNotificationHistory(project, {}, value)
    expect(result).toEqual(inspectProjectNotificationPage(value, project, {}))
    expect(result.semantics).toContain('not-human-delivery-or-approval')
  })
  it.each(['project', 'generation', 'scope-revision', 'row-revision', 'order', 'consistency', 'semantics', 'schema',
    'duplicate', 'cursor', 'partial-cursor', 'private-event', 'private-actor', 'url', 'event-kind', 'redeliver-self', 'invalid-date',
    'pending-at', 'backwards-settlement', 'accepted-code', 'uncertain-http', 'trace-zero', 'trace-flags'])(
    'refuses contradictory or private metadata: %s', fault => {
      const value: any = page(2), row = value.deliveries[0]
      if (fault === 'project') value.project.id = randomUUID()
      if (fault === 'generation') value.project.generation++
      if (fault === 'scope-revision') value.project.revision = 'c'.repeat(64)
      if (fault === 'row-revision') row.request.revision = 'c'.repeat(64)
      if (fault === 'order') value.order = 'time'
      if (fault === 'consistency') value.consistency = 'snapshot'
      if (fault === 'semantics') value.semantics = 'delivered'
      if (fault === 'schema') value.schemaVersion = 2
      if (fault === 'duplicate') value.deliveries[1].request.requestId = row.request.requestId
      if (fault === 'cursor') value.nextCursor = row.request.requestId
      if (fault === 'partial-cursor') { value.deliveries.pop(); value.nextCursor = row.request.requestId }
      if (fault === 'private-event') row.event = { body: 'PRIVATE_BODY' }
      if (fault === 'private-actor') row.actor = 'PRIVATE_ACTOR'
      if (fault === 'url') row.request.endpointId = 'https://PRIVATE_ENDPOINT'
      if (fault === 'event-kind') row.request.eventKind = 'PRIVATE_KIND'
      if (fault === 'redeliver-self') row.request.redeliverOf = row.request.requestId
      if (fault === 'invalid-date') row.createdAt = '2026-02-30T00:00:00.000Z'
      if (fault === 'pending-at') row.outcome.at = at
      if (fault === 'backwards-settlement') row.outcome = { status: 'settled', at: '2026-10-05T00:00:00.000Z', result: { status: 'accepted', httpStatus: 202 } }
      if (fault === 'accepted-code') row.outcome = { status: 'settled', at, result: { status: 'accepted', httpStatus: 503 } }
      if (fault === 'uncertain-http') row.outcome = { status: 'settled', at, result: { status: 'uncertain', reason: 'timeout', httpStatus: 202 } }
      if (fault === 'trace-zero') row.trace = { traceId: '0'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }
      if (fault === 'trace-flags') row.trace = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 2 }
      expect(() => projectPreviewNotificationHistory(project, { limit: 2 }, value)).toThrow('cannot be safely matched')
    })
  it('refuses a correct page label containing a foreign row revision in the owner inspector too', () => {
    const value = page(); value.deliveries[0]!.request.revision = 'c'.repeat(64)
    expect(() => inspectProjectNotificationPage(value, project, {})).toThrowError(expect.objectContaining({ code: 'corrupt' }))
  })
  it.each([{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { after: 'bad' }, { limit: 2, project }, { limit: 2, actor: 'override' }])(
    'refuses malformed browser page selection %#', request => {
      expect(() => projectPreviewNotificationHistory(project, request, page())).toThrow('cannot be safely matched')
    })
  it('admits a full keyset and rejects rows preceding the requested cursor', () => {
    const first = page(2, 0, true), tail = page(1, 2)
    expect(projectPreviewNotificationHistory(project, { limit: 2 }, first)).toEqual(first)
    expect(projectPreviewNotificationHistory(project, { limit: 2, after: first.nextCursor! }, tail)).toEqual(tail)
    expect(() => projectPreviewNotificationHistory(project, { limit: 2, after: first.nextCursor! }, first)).toThrow()
  })
})

describe('preview owner command boundary', () => {
  async function fixture(result: unknown = page()) {
    const call = vi.fn(async (command: RuntimeOperation) => command.operation === 'projects.command'
      ? { id: project.id, generation: 1, acceptedRevision: project.revision } : result)
    const session = await PreviewSession.create({ call }, source, project.id); call.mockClear()
    return { session, call }
  }
  it('forwards canonical filters only with its retained project pin', async () => {
    const filter = { outcome: 'pending' as const, createdFrom: at }, value = filteredPage(filter), f = await fixture(value)
    const request = { limit: 2, filter: { ...filter, eventKind: undefined } }
    expect(await f.session.operation({ operation: 'notifications.list', page: request })).toEqual(value)
    expect(f.call).toHaveBeenCalledExactlyOnceWith({ operation: 'notifications.project-list', project, page: { limit: 2, filter } })
  })
  it.each(invalidFilters)('rejects malformed filters before owner I/O: %j', filter => {
    return fixture().then(async f => {
      await expect(f.session.operation({ operation: 'notifications.list', page: { filter } })).rejects.toHaveProperty('code', 'invalid-command')
      expect(f.call).not.toHaveBeenCalled()
    })
  })
  it('refuses an older owner omitting the filter echo without an unfiltered retry', async () => {
    const f = await fixture(page())
    await expect(f.session.operation({ operation: 'notifications.list', page: { filter: { outcome: 'pending' } } })).rejects.toHaveProperty('code', 'corrupt')
    expect(f.call).toHaveBeenCalledTimes(1)
  })
  it('maps only to the retained historical pin, including a detached copy and bounded page', async () => {
    const value = page(), f = await fixture(value)
    expect(await f.session.operation({ operation: 'notifications.list', page: { limit: 2 } })).toEqual(value)
    expect(f.call).toHaveBeenCalledExactlyOnceWith({ operation: 'notifications.project-list', project, page: { limit: 2 } })
    const pin = f.session.pin; pin.generation = 99
    await f.session.operation({ operation: 'notifications.list', page: {} })
    expect(f.call.mock.calls[1]![0]).toEqual({ operation: 'notifications.project-list', project, page: { limit: 100 } })
  })
  it.each([{ operation: 'notifications.list' }, { operation: 'notifications.list', page: {}, project },
    { operation: 'notifications.list', page: {}, actor: 'override' }, { operation: 'notifications.list', page: { limit: 201 } },
    { operation: 'notifications.project-list', project, page: {} }, { operation: 'notifications.send', request: {} },
    { operation: 'notifications.prepare', pin: {} }, { operation: 'notifications.show', requestId: randomUUID() },
    { operation: 'notifications.destinations' }, { operation: 'notifications.abort', requestId: randomUUID() }])(
    'refuses widening or dispatch before owner I/O %#', async command => {
      const f = await fixture(); await expect(f.session.operation(command)).rejects.toHaveProperty('code', 'invalid-command')
      expect(f.call).not.toHaveBeenCalled()
    })
  it('refuses a corrupt reply without falling back to owner-wide history', async () => {
    const value = page(); value.project.generation = 2
    const f = await fixture(value)
    await expect(f.session.operation({ operation: 'notifications.list', page: {} })).rejects.toHaveProperty('code', 'corrupt')
    expect(f.call).toHaveBeenCalledTimes(1)
    expect(f.call.mock.calls[0]![0].operation).toBe('notifications.project-list')
  })
})

/** Serialized controller/element double, not browser, layout, CSP or accessibility qualification. */
class Element {
  private text = ''; children: Element[] = []; disabled = false; className = ''; tabIndex = -1; value = ''
  attributes = new Map<string, string>(); handlers = new Map<string, (() => void)[]>()
  set textContent(value: string) { this.text = value; this.children = [] }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join('\n') }
  set innerHTML(_value: string) { throw Error('Unsafe dynamic markup') }
  append(child: Element) { this.children.push(child) }
  replaceChildren() { this.children = []; this.text = '' }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  addEventListener(name: string, fn: () => void) { this.handlers.set(name, [...this.handlers.get(name) ?? [], fn]) }
  click() { for (const fn of this.handlers.get('click') ?? []) fn() }
  change(value: string) { this.value = value; for (const fn of this.handlers.get('change') ?? []) fn() }
}
function controls() {
  const elements = new Map([...notificationHistoryHtml.matchAll(/id="([^"]+)"/g)].map(match => [match[1]!, new Element()]))
  const get = (suffix: string) => elements.get('notification-history-' + suffix)!
  let current: { project: typeof project; session: string } | undefined = { project, session: 'PRIVATE_SESSION' }
  const pending: ReturnType<typeof Promise.withResolvers<unknown>>[] = [], events = new Map<string, () => void>()
  const request = vi.fn((_command: unknown) => { const next = Promise.withResolvers<unknown>(); pending.push(next); return next.promise })
  const controller = runInNewContext(`(${liveNotificationHistoryControls.toString()})(ctx, projectPage)`, {
    document: { getElementById: (key: string) => elements.get(key), createElement: () => new Element() },
    window: { addEventListener: (event: string, fn: () => void) => events.set(event, fn) },
    ctx: { request, current: () => current }, projectPage: projectPreviewNotificationHistory,
  }) as ReturnType<typeof liveNotificationHistoryControls>
  return { get, pending, request, events, controller, select: (value: typeof current) => { current = value; controller.observe() } }
}
const settle = async () => { await Promise.resolve(); await Promise.resolve() }
describe('read-only notification history controller', () => {
  it('can clear only staged drafts without reading or deleting records', () => {
    const f = controls(); f.get('outcome').change('uncertain'); f.get('created-from').change(at)
    expect(f.get('clear').disabled).toBe(false); f.get('clear').click()
    expect(f.get('outcome').value).toBe(''); expect(f.get('created-from').value).toBe('')
    expect(f.request).not.toHaveBeenCalled(); expect(f.get('clear').disabled).toBe(true)
  })
  it.each(['disconnect', 'session', 'pin', 'clear'])('discards filter drafts and applied replies on %s', async cause => {
    const f = controls(); f.get('outcome').change('pending'); f.get('created-from').change(at); f.get('load').click()
    if (cause === 'disconnect') f.select(undefined)
    if (cause === 'session') f.select({ project, session: 'OTHER_SESSION' })
    if (cause === 'pin') f.select({ project: { ...project, generation: 2 }, session: 'PRIVATE_SESSION' })
    if (cause === 'clear') f.get('clear').click()
    expect(f.get('outcome').value).toBe(''); expect(f.get('created-from').value).toBe('')
    f.pending[0]!.resolve(filteredPage({ outcome: 'pending', createdFrom: at })); await settle()
    expect(f.get('records').textContent).toBe(''); expect(f.request).toHaveBeenCalledTimes(1)
  })
  it('stages filters without reads, explicitly applies them and pins subsequent pages', async () => {
    const f = controls(), filter = { outcome: 'pending' as const, eventKind: 'requested' as const, createdFrom: at, createdBefore: '2026-10-07T00:00:00.000Z' }
    f.get('outcome').change(filter.outcome); f.get('event-kind').change(filter.eventKind)
    f.get('created-from').change(filter.createdFrom); f.get('created-before').change(filter.createdBefore)
    expect(f.request).not.toHaveBeenCalled()
    f.get('load').click(); expect(f.request.mock.calls[0]![0]).toEqual({ operation: 'notifications.list', page: { limit: 25, filter } })
    f.pending[0]!.resolve(filteredPage(filter, 25, 0, true)); await settle()
    expect(f.get('summary').textContent).toContain('Applied query: pending · requested')
    expect(f.get('summary').textContent).toContain('inclusive')
    f.get('next').click(); expect(f.request.mock.calls[1]![0]).toEqual({ operation: 'notifications.list', page: { limit: 25, filter, after: id(25) } })
    f.pending[1]!.resolve(filteredPage(filter, 25, 25, true)); await settle()
    f.get('outcome').change('accepted'); expect(f.get('next').disabled).toBe(true)
    f.get('next').click(); expect(f.request).toHaveBeenCalledTimes(2)
    expect(f.get('records').textContent).toContain(id(26))
    f.get('load').click(); expect(f.request.mock.calls[2]![0]).toEqual({ operation: 'notifications.list', page: { limit: 25, filter: { ...filter, outcome: 'accepted' } } })
  })
  it.each([['outcome', 'forged'], ['event-kind', 'approved'], ['created-from', '<PRIVATE_ERROR>'],
    ['created-before', '2026-10-01T00:00:00Z'], ['created-from', '2026-02-30T00:00:00.000Z']])('rejects invalid draft %s before any read', (field, value) => {
    const f = controls(); f.get(field).change(value); f.get('load').click()
    expect(f.request).not.toHaveBeenCalled(); expect(f.get('message').textContent).toContain('Invalid history filters')
    expect(f.get('message').textContent).not.toContain('PRIVATE_ERROR')
  })
  it('rejects reversed time bounds without discarding the displayed applied query', async () => {
    const f = controls(); f.get('load').click(); f.pending[0]!.resolve(page()); await settle()
    f.get('created-from').change('2026-10-07T00:00:00.000Z'); f.get('created-before').change(at); f.get('load').click()
    expect(f.request).toHaveBeenCalledTimes(1); expect(f.get('records').textContent).toContain(id(1))
    expect(f.get('summary').textContent).toContain('Applied query: all outcomes')
  })
  it('fences an in-flight reply when draft edits return to the original query', async () => {
    const f = controls(); f.get('outcome').change('pending'); f.get('load').click()
    f.get('outcome').change('accepted'); f.get('outcome').change('pending')
    f.pending[0]!.resolve(filteredPage({ outcome: 'pending' })); await settle()
    expect(f.get('records').textContent).toBe(''); expect(f.request).toHaveBeenCalledTimes(1)
    f.get('load').click(); f.pending[1]!.resolve(filteredPage({ outcome: 'pending' })); await settle()
    expect(f.get('records').textContent).toContain(id(1))
  })
  it('requires explicit restart after a live pending cursor settles without changing the query or retrying', async () => {
    const f = controls(); f.get('outcome').change('pending'); f.get('load').click()
    f.pending[0]!.resolve(filteredPage({ outcome: 'pending' }, 25, 0, true)); await settle()
    f.get('next').click(); f.pending[1]!.reject(Error('PRIVATE_SETTLED_CURSOR')); await settle()
    expect(f.request).toHaveBeenCalledTimes(2); expect(f.get('records').textContent).toBe('')
    expect(f.get('message').textContent).not.toContain('PRIVATE_SETTLED_CURSOR')
    expect(f.get('outcome').value).toBe('pending'); f.get('load').click()
    expect(f.request.mock.calls[2]![0]).toEqual({ operation: 'notifications.list', page: { limit: 25, filter: { outcome: 'pending' } } })
  })
  it('discards drafts and late reads on pagehide; pageshow does not restore or automatically read', async () => {
    const f = controls(); f.get('outcome').change('pending'); f.get('created-from').change(at); f.get('load').click()
    f.events.get('pagehide')!(); expect(f.get('outcome').value).toBe(''); expect(f.get('created-from').value).toBe('')
    expect(f.get('load').disabled).toBe(true); f.get('load').click(); expect(f.request).toHaveBeenCalledTimes(1)
    f.pending[0]!.resolve(filteredPage({ outcome: 'pending', createdFrom: at })); await settle()
    expect(f.get('records').textContent).toBe(''); f.events.get('pageshow')!(); expect(f.request).toHaveBeenCalledTimes(1)
    expect(f.get('load').disabled).toBe(false); f.get('load').click()
    expect(f.request.mock.calls[1]![0]).toEqual({ operation: 'notifications.list', page: { limit: 25 } })
  })
  it('does not automatically load and retains only the explicitly selected page', async () => {
    const f = controls(); expect(f.request).not.toHaveBeenCalled(); expect(f.get('next').disabled).toBe(true)
    f.controller.observe(); expect(f.request).not.toHaveBeenCalled()
    f.get('load').click(); f.get('load').click(); expect(f.request).toHaveBeenCalledTimes(1)
    expect(f.request.mock.calls[0]![0]).toEqual({ operation: 'notifications.list', page: { limit: 25 } })
    f.pending[0]!.resolve(page(25, 0, true)); await settle()
    expect(f.get('records').textContent).toContain('dispatch and external outcome unknown')
    expect(f.get('records').textContent).not.toContain('PRIVATE_SESSION')
    expect(f.get('next').disabled).toBe(false)
    f.get('next').click(); expect(f.get('records').textContent).toBe('')
    expect(f.request.mock.calls[1]![0]).toEqual({ operation: 'notifications.list', page: { limit: 25, after: id(25) } })
    f.pending[1]!.resolve(page(1, 25)); await settle()
    expect(f.get('records').textContent).toContain(id(26)); expect(f.get('records').textContent).not.toContain(id(1))
    expect(f.get('next').disabled).toBe(true)
    f.get('load').click(); expect(f.request.mock.calls[2]![0]).toEqual({ operation: 'notifications.list', page: { limit: 25 } })
  })
  it.each(['disconnect', 'session', 'pin', 'clear', 'pagehide'])('discards stale data after %s, including returning to the original identity', async cause => {
    const f = controls(); f.get('load').click()
    if (cause === 'disconnect') f.select(undefined)
    if (cause === 'session') f.select({ project, session: 'OTHER_SESSION' })
    if (cause === 'pin') f.select({ project: { ...project, generation: 2 }, session: 'PRIVATE_SESSION' })
    if (cause === 'clear') f.get('clear').click()
    if (cause === 'pagehide') f.events.get('pagehide')!()
    f.select({ project, session: 'PRIVATE_SESSION' })
    f.pending[0]!.resolve(page()); await settle()
    expect(f.get('records').textContent).toBe(''); expect(f.get('summary').textContent).toBe('')
    expect(f.request).toHaveBeenCalledTimes(1)
    if (cause === 'pagehide') f.events.get('pageshow')!()
    f.get('load').click(); f.pending[1]!.resolve(page()); await settle()
    expect(f.get('records').textContent).toContain(id(1))
  })
  it.each(['bad-reply', 'failed-read'])('clears invalid or unavailable history without raw errors or automatic fallback: %s', async cause => {
    const f = controls(); f.get('load').click()
    if (cause === 'bad-reply') f.pending[0]!.resolve({ ...page(), private: 'PRIVATE_ERROR' })
    else f.pending[0]!.reject(Error('PRIVATE_ERROR'))
    await settle()
    expect(f.get('message').textContent).toContain('History unavailable or invalid')
    expect(f.get('message').textContent).not.toContain('PRIVATE_ERROR')
    expect(f.get('records').textContent).toBe(''); expect(f.request).toHaveBeenCalledTimes(1)
  })
  it('renders uncertain/accepted outcomes and traces only as inert text', async () => {
    const f = controls(), value: any = page(2)
    value.deliveries[0].outcome = { status: 'settled', at, result: { status: 'accepted', httpStatus: 202 } }
    value.deliveries[1].outcome = { status: 'settled', at, result: { status: 'uncertain', reason: 'aborted' } }
    value.deliveries[0].trace = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 0 }
    f.get('load').click(); f.pending[0]!.resolve(value); await settle()
    expect(f.get('records').textContent).toContain('not human delivery or approval')
    expect(f.get('records').textContent).toContain('never automatically redeliver')
    expect(f.get('records').textContent).toContain('Collector delivery unproven')
  })
  it('includes both serialized functions in one hash-pinned script and unique panel IDs', () => {
    const { html, csp } = renderLivePage(randomUUID(), PROTOCOL_VERSION)
    const script = /<script>([\s\S]*?)<\/script>/u.exec(html)![1]!
    new Script(script)
    expect(script).toContain('function liveNotificationHistoryControls'); expect(script).toContain('function projectPreviewNotificationHistory')
    expect(csp).toContain(`script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`)
    const ids = [...html.matchAll(/id="([^"]+)"/g)].map(x => x[1])
    expect(new Set(ids).size).toBe(ids.length); expect(ids).toContain('notification-history-load')
    expect(html).not.toContain('PRIVATE_SESSION')
  })
})

describe('private HTTPS management owner and scoped history gateway', () => {
  it('reads historical metadata with no extra sends, approvals or journal writes and retains the owner after gateway close', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-preview-notification-')), tls = await createTlsFixture(directory), port = await fixturePort()
    let sends = 0
    const receiver = createServer((request, response) => { sends++; request.resume(); response.writeHead(202); response.end() })
    await new Promise<void>((resolve, reject) => { receiver.once('error', reject); receiver.listen(0, '127.0.0.1', resolve) })
    cleanup.push(() => new Promise<void>(resolve => { receiver.closeAllConnections(); receiver.close(() => resolve()) }))
    const address = receiver.address(); if (!address || typeof address === 'string') throw Error('Missing fixture receiver')
    const endpoint = { id: 'review', url: `http://127.0.0.1:${address.port}`, credentialRef: 'review/key', timeoutMs: 1000 }
    const ownerToken = randomBytes(32).toString('hex'), previewToken = randomBytes(32).toString('hex')
    const owner = await startRuntimeService({ runtime: { dataDirectory: join(directory, 'state'), notifications: { endpoints: [endpoint] } },
      token: ownerToken, actor: 'fixture:owner', port, tls: { publicOrigin: `https://127.0.0.1:${port}`, bindAddress: '127.0.0.1',
        certificateFile: tls.cert, privateKeyFile: tls.key } })
    cleanup.push(() => owner.close())
    const client = new RuntimeClient(owner.url, ownerToken, 5000, 20_000_000, { ca: tls.ca, expectedInstanceId: owner.instanceId })
    const call = async (command: RuntimeOperation) => (await client.operation(command) as { result: any }).result
    expect((await client.capabilities() as any).livePreviewNotificationHistory).toBe(false)
    await call({ operation: 'credentials.set', ref: endpoint.credentialRef, value: 'whsec_' + randomBytes(32).toString('base64'), expectedGeneration: 0 })
    const gateway = await startPreviewGateway({ source, projectId: randomUUID(), token: previewToken }, { call })
    cleanup.push(() => gateway.close())
    const post = (path: string, command: unknown, token: string) => fetch(gateway.url + path, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Jevable-Protocol': PROTOCOL_VERSION }, body: JSON.stringify(command) })
    const boot = await post('/v1/preview/bootstrap', {}, previewToken); expect(boot.status).toBe(200)
    const session = (await boot.json() as any).result, pin = session.project
    const foreign = await call({ operation: 'projects.command', command: { operation: 'create', id: randomUUID(), title: 'Foreign', yaml: source } })
    const runs: any[] = [], selected: string[] = [], foreignRequests: string[] = []
    for (let i = 0; i < 5; i++) {
      const scope = i < 3 ? pin : { id: foreign.id, generation: foreign.generation, revision: foreign.acceptedRevision }
      const run = await call({ operation: 'projects.run', id: scope.id, expectedGeneration: scope.generation, revision: scope.revision,
        runId: randomUUID(), input: { message: 'SYNTHETIC_PRIVATE_REVIEW' } })
      expect(run.status).toBe('waiting'); runs.push(run)
      const prepared = await call({ operation: 'notifications.prepare', pin: { runId: run.id, revision: run.revision, attemptId: run.attemptId }, endpointId: endpoint.id })
      const { event: _event, delivery: _delivery, ...request } = prepared, requestId = randomUUID()
      await call({ operation: 'notifications.send', request: { ...request, requestId } })
      ;(i < 3 ? selected : foreignRequests).push(requestId)
    }
    expect(sends).toBe(5)
    await call({ operation: 'projects.command', command: { operation: 'rename', id: pin.id, expectedGeneration: pin.generation, title: 'Renamed' } })
    const before = await Promise.all(runs.map(run => call({ operation: 'runs.events', id: run.id })))
    const read = async (command: unknown) => { const response = await post('/v1/preview/operations', command, session.token)
      expect(response.status).toBe(200); return (await response.json() as any).result }
    const first = await read({ operation: 'notifications.list', page: { limit: 2 } })
    expect(first.project).toEqual(pin); expect(first.deliveries.map((row: any) => row.request.requestId)).toEqual(selected.sort().slice(0, 2))
    const last = await read({ operation: 'notifications.list', page: { limit: 2, after: first.nextCursor } })
    expect(last.deliveries.map((row: any) => row.request.requestId)).toEqual(selected.slice(2)); expect(last.nextCursor).toBeNull()
    expect(JSON.stringify([first, last])).not.toMatch(/SYNTHETIC_PRIVATE|credentialGeneration|fixture:owner|http:\/\//)
    const filter = { outcome: 'accepted', eventKind: 'requested', createdFrom: first.deliveries[0].createdAt }
    const filtered = await read({ operation: 'notifications.list', page: { limit: 2, filter } })
    expect(filtered.filter).toEqual(filter); expect(filtered.project).toEqual(pin)
    expect(projectPreviewNotificationHistory(pin, { limit: 2, filter } as never, filtered)).toEqual(filtered)
    expect((await read({ operation: 'notifications.list', page: { filter: { outcome: 'pending' } } })).deliveries).toEqual([])
    expect((await read({ operation: 'notifications.list', page: { filter: { createdBefore: first.deliveries[0].createdAt } } })).deliveries)
      .toEqual([...first.deliveries, ...last.deliveries].filter((row: any) => row.createdAt < first.deliveries[0].createdAt))
    for (const bad of [{}, { outcome: 'settled' }, { createdFrom: at, createdBefore: at }])
      expect((await post('/v1/preview/operations', { operation: 'notifications.list', page: { filter: bad } }, session.token)).status).toBe(400)
    for (const after of [foreignRequests[0], randomUUID()]) expect((await post('/v1/preview/operations',
      { operation: 'notifications.list', page: { after } }, session.token)).status).toBe(404)
    for (const command of [{ operation: 'notifications.list', page: {}, project: pin }, { operation: 'notifications.send', request: {} },
      { operation: 'notifications.show', requestId: selected[0] }]) expect((await post('/v1/preview/operations', command, session.token)).status).toBe(400)
    expect((await post('/v1/preview/bootstrap', {}, ownerToken)).status).toBe(401)
    expect((await post('/v1/operations', { operation: 'notifications.list', page: {} }, session.token)).status).not.toBe(200)
    expect(await Promise.all(runs.map(run => call({ operation: 'runs.events', id: run.id })))).toEqual(before)
    expect(await Promise.all(runs.map(run => call({ operation: 'runs.show', id: run.id })))).toEqual(runs)
    await gateway.close(); await client.health(); expect(sends).toBe(5)
  }, 20000)
})
