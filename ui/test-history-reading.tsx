import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { RecordedValue } from './recorded-values'
import { SavedTestChecks } from './saved-test-checks'

// A reading view of explicitly inspected controller data. No fetch, action,
// authority, storage or changes to the current case/editor belong here.
const outcomes: Record<string, string> = { completed: 'finish successfully', waiting: "wait for a person's approval",
  failed: 'report a failure', cancelled: 'stop after cancellation' }
function read() {
  const text = document.getElementById('test-history-detail')!.textContent ?? ''
  if (!text) return { kind: 'empty' as const }
  try {
    if (text.length > 1_000_000) throw Error('reading-limit')
    const item = JSON.parse(text), definition = item?.definition
    const statuses = definition?.expectations?.filter?.((check: any) => check?.kind === 'status')
    if (!Number.isSafeInteger(item?.generation) || item.generation < 1 || !['draft', 'accepted'].includes(item.status)
      || !definition || typeof definition.title !== 'string' || definition.title.length > 16384
      || !Object.hasOwn(definition, 'input') || !Array.isArray(definition.expectations) || definition.expectations.length > 64
      || statuses?.length !== 1 || !Object.hasOwn(outcomes, statuses[0].value)
      || (definition.triggerMode !== undefined && definition.triggerMode !== 'api')) throw Error('unavailable-definition')
    return { kind: 'loaded' as const, item, outcome: outcomes[statuses[0].value] }
  } catch { return { kind: 'unavailable' as const } }
}
export function TestHistoryReading() {
  const [reading, setReading] = useState(read)
  useLayoutEffect(() => {
    const source = document.getElementById('test-history-detail')!
    const observer = new MutationObserver(() => setReading(read()))
    observer.observe(source, { childList: true, characterData: true, subtree: true })
    setReading(read())
    return () => observer.disconnect()
  }, [])
  const host = document.getElementById('test-history-reading')!
  if (reading.kind !== 'loaded') return createPortal(<p>{reading.kind === 'empty'
    ? 'No historical definition loaded. Choose a version, then inspect it to read its saved input and expected outcome.'
    : 'This historical definition could not be displayed safely. Inspect its exact record below; no action was taken.'}</p>, host)
  const { item, outcome } = reading, definition = item.definition
  return createPortal(<div className="saved-test-guide">
    <h4>Saved version {item.generation}: {definition.title}</h4>
    <p>Expected outcome: {outcome}</p>
    <p>Saved state: {item.archived === true ? 'archived' : item.status === 'accepted' ? 'accepted at this version' : 'draft at this version'}</p>
    <p>Starts from: {definition.triggerMode === 'api' ? 'API request' : 'Default workflow entry'}</p>
    <div className="saved-test-input"><span className="value-label">Saved input</span><RecordedValue value={definition.input} /></div>
    <SavedTestChecks expectations={definition.expectations} />
    <p className="test-next-step">Historical definition only. The editor and latest saved version above are unchanged. Viewing this version never accepts, runs or restores a test.</p>
  </div>, host)
}
