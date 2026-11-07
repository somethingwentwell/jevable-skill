import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'

// Presentation only: observe explicitly loaded controller text, never request,
// reconstruct, execute, copy to storage or change an authorization control.
const element = (id: string) => document.getElementById(id)!
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const probability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const percent = (value: number) => value > 0 && value < 0.0001 ? '<0.01%'
  : value < 1 && value > 0.9999 ? '>99.99%' : `${Number((value * 100).toFixed(2))}%`
const parse = (text: string): unknown => { try { return text.length <= 20_000_000 ? JSON.parse(text) : undefined } catch { return undefined } }
function useText(ids: string[]) {
  const read = () => ids.map(id => element(id).textContent ?? '')
  const [texts, setTexts] = useState(read)
  useLayoutEffect(() => {
    const observer = new MutationObserver(() => setTexts(read()))
    for (const id of ids) observer.observe(element(id), { childList: true, characterData: true, subtree: true })
    return () => observer.disconnect()
  }, [ids.join('|')])
  return texts
}

/** A bounded reading view, never a replacement for the exact JSON underneath it. */
export function RecordedValue({ value }: { value: unknown }) {
  const budget = { nodes: 48, characters: 6000 }
  let shortened = false
  const text = (value: string) => {
    const length = Math.max(0, Math.min(1200, budget.characters)); budget.characters -= Math.min(value.length, length)
    if (value.length <= length) return value
    shortened = true; return value.slice(0, length) + '…'
  }
  const render = (value: unknown, depth = 0): React.ReactNode => {
    if (--budget.nodes < 0 || budget.characters <= 0 || depth > 4) { shortened = true; return <span className="value-omitted">See exact JSON</span> }
    if (value === null) return <span className="value-empty">No value (null)</span>
    if (typeof value === 'string') return <span className="value-text">{value === '' ? 'Empty text' : text(value)}</span>
    if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>
    if (typeof value === 'number') return <span className="value-number">{String(value)}</span>
    const record = object(value)
    if (!record && !Array.isArray(value)) return <span className="value-empty">No value recorded</span>
    if (record?.type === 'noul' && Object.keys(record).length === 2 && probability(record.noul)) {
      return <div className="judgment-value"><span className="value-label">Chance of yes</span>
        <strong className="judgment-number">{percent(record.noul)}</strong>
        <span className="value-help">An estimate, not a yes/no verdict or permission to continue.</span>
        <span className="value-help">This answer has no separate confidence score.</span></div>
    }
    if (record?.type === 'choice' && typeof record.choice === 'string' && typeof record.confidence === 'number'
      && object(record.probabilities) && (!Object.hasOwn(record, 'explanation') || typeof record.explanation === 'string')
      && Object.keys(record).every(key => ['type', 'choice', 'confidence', 'probabilities', 'explanation'].includes(key))) {
      return <div className="judgment-value"><span className="value-label">Chosen outcome</span><strong className="judgment-choice">{text(record.choice)}</strong>
        <span className="value-help">Confidence <b className="value-number">{Number.isFinite(record.confidence) && record.confidence >= 0 && record.confidence <= 1 ? `${Number((record.confidence * 100).toFixed(2))}%` : String(record.confidence)}</b></span>
        <details className="value-probabilities"><summary>Other possible outcomes</summary>{render(record.probabilities, depth + 1)}</details>
        {typeof record.explanation === 'string' && <p>{record.explanation === '' ? 'Empty text' : text(record.explanation)}</p>}</div>
    }
    // Recognize the two actual score envelopes. Do not round a fractional score
    // into a category, derive confidence from the distribution, or hide extras.
    if (record?.type === 'score' && typeof record.score === 'number' && Number.isFinite(record.score)
      && probability(record.confidence) && (!Object.hasOwn(record, 'explanation') || typeof record.explanation === 'string')
      && Object.keys(record).every(key => ['type', 'score', 'confidence', 'probabilities', 'legend', 'explanation'].includes(key))) {
      const nativeProbabilities = object(record.probabilities), legend = object(record.legend)
      const normalized = !Object.hasOwn(record, 'legend') && Array.isArray(record.probabilities)
        && record.probabilities.length > 0 && record.probabilities.every(probability)
      const native = nativeProbabilities && legend && Object.keys(legend).length > 0
        && Object.values(legend).every(value => typeof value === 'string')
        && Object.values(nativeProbabilities).every(probability)
        && Object.keys(legend).length === Object.keys(nativeProbabilities).length
        && Object.keys(legend).every(key => Object.hasOwn(nativeProbabilities, key))
      if (normalized || native) return <div className="judgment-value"><span className="value-label">Score</span>
        <strong className="judgment-number">{String(record.score)}</strong>
        <span className="value-help">Confidence <b className="value-number">{percent(record.confidence)}</b></span>
        <span className="value-help">A saved numeric score, not a selected category.</span>
        {typeof record.explanation === 'string' && <p>{record.explanation === '' ? 'Empty text' : text(record.explanation)}</p>}
        <details className="value-probabilities"><summary>How this score is described</summary>
          {native && <><span className="value-label">Score meanings</span>{render(legend, depth + 1)}</>}
          <span className="value-label">Reported probabilities</span>{render(record.probabilities, depth + 1)}</details></div>
    }
    // OpenAI-compatible Noul is a yes/no probability with reported confidence.
    // Native System One Noul above is a different envelope, with no confidence.
    if (record?.type === 'noul' && probability(record.probability) && probability(record.confidence)
      && (!Object.hasOwn(record, 'explanation') || typeof record.explanation === 'string')
      && Object.keys(record).every(key => ['type', 'probability', 'confidence', 'explanation'].includes(key))) {
      return <div className="judgment-value"><span className="value-label">Probability of yes</span>
        <strong className="judgment-number">{percent(record.probability)}</strong>
        <span className="value-help">Confidence <b className="value-number">{percent(record.confidence)}</b></span>
        <span className="value-help">A saved probability, not a yes/no verdict or permission to continue.</span>
        {typeof record.explanation === 'string' && <p>{record.explanation === '' ? 'Empty text' : text(record.explanation)}</p>}</div>
    }
    const entries: [string, unknown][] = Array.isArray(value) ? value.slice(0, 12).map((item, index) => [`Item ${index + 1}`, item]) : Object.entries(record!).slice(0, 12)
    if ((Array.isArray(value) ? value.length : Object.keys(record!).length) > entries.length) shortened = true
    if (!entries.length) return <span className="value-empty">{Array.isArray(value) ? 'Empty list' : 'Empty object'}</span>
    return <dl className="recorded-fields">{entries.map(([key, item]) => <div key={key}><dt>{text(key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' '))}</dt><dd>{render(item, depth + 1)}</dd></div>)}</dl>
  }
  const content = render(value)
  return <div className="recorded-value">{content}{shortened && <p className="value-help">This reading view is shortened. Open the exact JSON for the complete value.</p>}</div>
}
function RunValues() {
  const [raw, current] = useText(['live-private-result', 'live-result'])
  const inspection = object(parse(raw!)), run = object(inspection?.run), state = object(run?.state), receipt = object(parse(current!))
  if (!raw) return null
  const matches = inspection?.privateInspection === true && run && state && receipt && receipt.id === run.id
    && receipt.revision === run.revision && receipt.status === state.status
  return createPortal(<section className="private-reading" aria-label="Loaded workflow values">
    <h3>Workflow output</h3>{!matches ? <p>These values do not match the current status. Refresh status, then choose Show inputs and output again.</p>
      : <>{Object.hasOwn(state, 'output') ? <RecordedValue value={state.output} /> : <p>No final output is recorded at this checkpoint.</p>}
        <details className="value-input"><summary>Input used for this run</summary><RecordedValue value={run.input} /></details></>}
    <p className="value-help">Loaded on your request. This is recorded data, not proof that an outside action succeeded.</p>
  </section>, element('live-private-summary'))
}
function NodeValues() {
  const [input, output, kind] = useText(['node-private-input', 'node-private-output', 'detail-kind'])
  if (!input && !output) return null
  const field = (raw: string) => {
    const value = parse(raw)
    if (value !== undefined) return <RecordedValue value={value} />
    // Only map the controller's exact unavailable messages. Arbitrary saved
    // strings must remain verbatim, including strings resembling these messages.
    return <p>{raw.startsWith('Unsettled:') ? 'No output is recorded for this step.'
      : raw.startsWith('Unavailable:') ? 'No saved value is available for this step.' : raw}</p>
  }
  const request = object(parse(input!))
  const approvalRequest = kind?.includes('Human Approval') && request && typeof request.title === 'string'
    && Object.hasOwn(request, 'input') && Array.isArray(request.actions)
  return createPortal(<div className="private-reading node-reading"><section><h3>What came out</h3>{field(output!)}</section>
    {approvalRequest ? <section className="value-input"><h3>What was reviewed</h3><RecordedValue value={request.input} />
      <details className="value-input"><summary>More request details</summary><RecordedValue value={request} /></details></section>
      : <details className="value-input"><summary>What went in</summary>{field(input!)}</details>}
  </div>, element('node-private-summary'))
}
function ApprovalValues() {
  const [raw] = useText(['live-review-data']), review = object(parse(raw!)), prepared = object(review?.input)
  if (!raw || review?.status !== 'ready' || !prepared) return null
  return createPortal(<div className="approval-reading"><h3>{typeof prepared.title === 'string' ? prepared.title : 'Review this request'}</h3>
    {Object.hasOwn(prepared, 'input') && <RecordedValue value={prepared.input} />}
    <p className="value-help">Read the request above, confirm you've reviewed it, then choose an action below. Nothing is approved by opening this panel.</p>
  </div>, element('live-review-summary'))
}
function StepExecution() {
  const [raw] = useText(['detail-execution-body']), record = object(parse(raw!))
  if (!record || typeof record.status !== 'string' || !Number.isSafeInteger(record.recordedResults)) return null
  const status = ({ 'Recorded result': 'Result saved', 'No recorded result': 'No saved result yet', 'Next · not executed': 'This step is next',
    'Approval wait': 'Waiting for your decision', 'Intent · outcome unsettled': 'No confirmed result yet', 'Failed checkpoint': 'This step needs attention',
    'Stopped · no rollback': 'Run stopped', 'Current loop': 'Repeating these steps' } as Record<string, string>)[record.status] ?? record.status
  return createPortal(<div className="step-recorded-summary"><strong>{status}</strong>
    <details className="value-input"><summary>About saved records</summary><span>{String(record.recordedResults)} recorded {record.recordedResults === 1 ? 'result' : 'results'}</span>
      <small>Recorded results can include loop bookkeeping; they are not a count of provider calls.</small></details></div>, element('step-execution-summary'))
}
export function RecordedPresentations() { return <><RunValues /><NodeValues /><ApprovalValues /><StepExecution /></> }
