/// <reference lib="dom" />
import type { NotificationProjectScope, ProjectNotificationPage } from '../notifications/project-history.ts'
import type { NotificationFilter } from '../notifications/history.ts'
import type { projectPreviewNotificationHistory } from './notification-history.ts'

/** One explicitly read page in memory. No polling, storage, sends, approvals or HTML interpretation. */
export function liveNotificationHistoryControls(ctx: {
  request: (command: unknown) => Promise<unknown>;
  current: () => { project: NotificationProjectScope; session: string } | undefined;
}, projectPage: typeof projectPreviewNotificationHistory) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  let identity = '', version = 0, busy = false, visible = true, snapshot: ProjectNotificationPage | undefined
  const limit = 25
  const fields = ['outcome', 'event-kind', 'created-from', 'created-before']
  const draft = (): NotificationFilter | undefined => {
    const value = (name: string) => el<HTMLInputElement>('notification-history-' + name).value ?? ''
    const outcome = value('outcome'), eventKind = value('event-kind'), createdFrom = value('created-from'), createdBefore = value('created-before')
    if (outcome && !['pending', 'accepted', 'rejected', 'uncertain'].includes(outcome)
      || eventKind && !['requested', 'decided', 'expired', 'cancelled'].includes(eventKind)) throw Error('Invalid filter')
    for (const at of [createdFrom, createdBefore]) {
      if (at && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(at) || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at)) throw Error('Invalid bound')
    }
    if (createdFrom && createdBefore && Date.parse(createdFrom) >= Date.parse(createdBefore)) throw Error('Invalid range')
    if (!outcome && !eventKind && !createdFrom && !createdBefore) return undefined
    return { ...(outcome ? { outcome: outcome as NotificationFilter['outcome'] } : {}),
      ...(eventKind ? { eventKind: eventKind as NotificationFilter['eventKind'] } : {}),
      ...(createdFrom ? { createdFrom } : {}), ...(createdBefore ? { createdBefore } : {}) }
  }
  const draftMatches = () => { try { return JSON.stringify(draft()) === JSON.stringify(snapshot?.filter) } catch { return false } }
  const describe = (filter?: NotificationFilter) => `Applied query: ${filter?.outcome ?? 'all outcomes'} · ${filter?.eventKind ?? 'all lifecycle kinds'}${filter?.createdFrom ? ` · created from ${filter.createdFrom} inclusive` : ''}${filter?.createdBefore ? ` · created before ${filter.createdBefore} exclusive` : ''}.`
  const add = (parent: HTMLElement, tag: string, text: string) => {
    const child = document.createElement(tag); child.textContent = text; parent.append(child); return child
  }
  const buttons = () => {
    el<HTMLButtonElement>('notification-history-load').disabled = !identity || busy || !visible
    el<HTMLButtonElement>('notification-history-next').disabled = !identity || busy || !visible || !snapshot?.nextCursor || !draftMatches()
    el<HTMLButtonElement>('notification-history-clear').disabled = !snapshot && !busy
      && !fields.some(name => el<HTMLInputElement>('notification-history-' + name).value)
    for (const name of fields) el<HTMLInputElement>('notification-history-' + name).disabled = !identity || !visible
  }
  const render = () => {
    const list = el('notification-history-records'); list.replaceChildren()
    el('notification-history-summary').textContent = snapshot
      ? `Project ${snapshot.project.id} · historical generation ${snapshot.project.generation} · revision ${snapshot.project.revision}. ${describe(snapshot.filter)} This page has ${snapshot.deliveries.length} recorded deliveries${snapshot.nextCursor ? '; more identities can be read' : '; no further identities were returned by this read'}.` : ''
    if (snapshot?.deliveries.length) {
      const scroll = document.createElement('div'); scroll.className = 'model-history-scroll'; scroll.tabIndex = 0
      scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', 'Recorded notification deliveries'); list.append(scroll)
      const table = document.createElement('table'); scroll.append(table)
      add(table, 'caption', 'Recorded delivery attempts; HTTP acceptance is not human delivery or approval')
      const head = document.createElement('thead'), titles = document.createElement('tr'); head.append(titles); table.append(head)
      for (const title of ['Request / event', 'Run / approval attempt', 'Destination / event pins', 'Intent / settlement', 'Recorded outcome', 'Trace / span'])
        add(titles, 'th', title).setAttribute('scope', 'col')
      const body = document.createElement('tbody'); table.append(body)
      for (const record of snapshot.deliveries) {
        const row = document.createElement('tr'); body.append(row)
        const request = record.request
        add(row, 'td', `${request.requestId}\n${request.eventKind ?? 'requested'}${request.redeliverOf ? `\nExplicit redelivery of ${request.redeliverOf}` : ''}`)
        add(row, 'td', `${request.runId}\n${request.attemptId}`)
        add(row, 'td', `${request.endpointId}\nDestination pin ${request.endpointSha256}\nEvent pin ${request.eventSha256}`)
        add(row, 'td', `${record.createdAt}\n${record.outcome.status === 'settled' ? record.outcome.at : 'Settlement unrecorded'}`)
        add(row, 'td', record.outcome.status === 'pending' ? 'Pending intent; dispatch and external outcome unknown'
          : record.outcome.result.status === 'uncertain' ? `Uncertain · ${record.outcome.result.reason}; inspect, never automatically redeliver`
            : `${record.outcome.result.status} · HTTP ${record.outcome.result.httpStatus}; not human delivery or approval`)
        add(row, 'td', record.trace ? `${record.trace.traceId}\n${record.trace.spanId}\nflags ${record.trace.traceFlags}; Collector delivery unproven` : 'Trace context unrecorded')
      }
    }
    buttons()
  }
  const clear = () => {
    version++; busy = false; snapshot = undefined
    for (const name of fields) el<HTMLInputElement>('notification-history-' + name).value = ''
    render()
    el('notification-history-message').textContent = identity ? 'Displayed history cleared; stored deliveries are unchanged.' : 'Connect to inspect this preview project.'
  }
  const observe = () => {
    const current = ctx.current(), next = current ? `${current.session}:${current.project.id}:${current.project.generation}:${current.project.revision}` : ''
    if (next !== identity) {
      identity = next; clear()
      el('notification-history-message').textContent = next ? 'Load one read-only page for this preview project.' : 'Connect to inspect this preview project.'
    }
    buttons(); return current
  }
  const read = async (next: boolean) => {
    const current = observe(); if (!current || busy || !visible || next && (!snapshot?.nextCursor || !draftMatches())) return
    let filter: NotificationFilter | undefined
    try { filter = next ? snapshot?.filter : draft() }
    catch { el('notification-history-message').textContent = 'Invalid history filters. Choose a listed outcome/kind and exact UTC ISO timestamps with milliseconds; the From bound must precede Before. Nothing was read or changed.'; buttons(); return }
    const page = { limit, ...(filter ? { filter: { ...filter } } : {}), ...(next ? { after: snapshot!.nextCursor! } : {}) }
    const expected = identity, token = ++version, scope = { ...current.project }
    busy = true; snapshot = undefined; render()
    el('notification-history-message').textContent = `Reading retained delivery metadata. ${describe(filter)} No notification or workflow action is being taken.`
    try {
      const value = await ctx.request({ operation: 'notifications.list', page })
      const checked = projectPage(scope, page, value)
      observe(); if (token !== version || identity !== expected) return
      snapshot = checked; render()
      el('notification-history-message').textContent = checked.deliveries.length
        ? 'Read complete. UUID order is not event-time order. Pages are live reads, not a snapshot; restart to observe updates or earlier inserted identities. A settled pending cursor can become invalid.'
        : 'No matching recorded deliveries in this page. This is not proof of no external notification or a completed workflow.'
    } catch {
      observe(); if (token !== version || identity !== expected) return
      snapshot = undefined; render()
      el('notification-history-message').textContent = 'History unavailable or invalid. Inspect the same project through the owner CLI/API; no sends, approvals or execution were retried.'
    } finally { if (token === version) { busy = false; buttons() } }
  }
  el('notification-history-load').addEventListener('click', () => { void read(false) })
  el('notification-history-next').addEventListener('click', () => { void read(true) })
  el('notification-history-clear').addEventListener('click', clear)
  const changed = () => {
    if (busy) { version++; busy = false; snapshot = undefined; render() }
    buttons()
    el('notification-history-message').textContent = 'Draft filters changed. Load / restart history explicitly to apply them; no read or delivery was started. Next page is available only for the displayed applied query.'
  }
  for (const name of fields) {
    el('notification-history-' + name).addEventListener('input', changed)
    el('notification-history-' + name).addEventListener('change', changed)
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => { visible = false; clear() })
    window.addEventListener('pageshow', () => { visible = true; observe() })
  }
  observe()
  return { observe, clear }
}

export const notificationHistoryHtml = `<section class="panel live" id="notification-history" hidden aria-label="Project approval notification delivery history"><h2>Approval notification history · read-only</h2>
<p>Only this preview project's historical generation and revision. UUID order is not time order; pages are live reads, not one snapshot. Pending intent does not prove dispatch. HTTP acceptance is not human delivery or approval. Private review/event bodies, actors, signing keys and destination URLs are not shown; identifiers still need review before sharing.</p>
<fieldset><legend>History filters · applied only on Load / restart</legend><div class="live-grid">
<label for="notification-history-outcome">Recorded outcome <select id="notification-history-outcome"><option value="">All outcomes</option><option value="pending">Pending</option><option value="accepted">HTTP accepted</option><option value="rejected">HTTP rejected</option><option value="uncertain">Uncertain</option></select></label>
<label for="notification-history-event-kind">Lifecycle kind <select id="notification-history-event-kind"><option value="">All lifecycle kinds</option><option value="requested">Requested</option><option value="decided">Decided</option><option value="expired">Expired</option><option value="cancelled">Cancelled</option></select></label>
<label for="notification-history-created-from">Created from · inclusive <input id="notification-history-created-from" type="text" maxlength="24" autocomplete="off" spellcheck="false" placeholder="2026-10-01T00:00:00.000Z" aria-describedby="notification-history-filter-help"></label>
<label for="notification-history-created-before">Created before · exclusive <input id="notification-history-created-before" type="text" maxlength="24" autocomplete="off" spellcheck="false" placeholder="2026-10-02T00:00:00.000Z" aria-describedby="notification-history-filter-help"></label>
</div><p id="notification-history-filter-help">Optional UTC ISO timestamps with milliseconds, ending in Z. Bounds use delivery creation time, not event time. Editing filters never reads or sends; restart to apply. No query is saved in browser storage.</p></fieldset>
<div class="live-controls"><button id="notification-history-load" disabled>Load / restart history</button><button id="notification-history-next" disabled>Read next page</button><button id="notification-history-clear" disabled>Clear displayed history</button></div>
<p id="notification-history-message" role="status" aria-live="polite"></p><p id="notification-history-summary"></p><div id="notification-history-records"></div></section>`
