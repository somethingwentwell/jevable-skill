import { RecordedValue } from './recorded-values'

// Read explicitly loaded definitions only. This component never grades a case,
// changes its exact JSON, grants authority, or dispatches a runtime operation.
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const node = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value)
const failures: Record<string, string> = {
  'invalid-node-value': 'A step must report an invalid value.',
  'loop-limit': 'The workflow must stop at its repetition limit.',
  'loop-timeout': 'The workflow must stop at its repetition time limit.',
  'approval-rejected': "A person's rejection must stop the workflow.",
  'approval-expired': 'An unanswered approval must expire and stop the workflow.',
  'ai-budget': 'The workflow must stop at its AI budget limit.',
}
function describe(value: unknown) {
  const check = record(value)
  if (!check) return undefined
  const keys = Object.keys(check)
  const shape = (allowed: string[]) => keys.every(key => allowed.includes(key))
  const scope = record(check.scope)
  if (check.scope !== undefined && (!scope || !shape(['kind', 'nodeId', 'scope', 'value'])
    || Object.keys(scope).some(key => !['loop', 'index'].includes(key)) || !node(scope.loop)
    || !Number.isSafeInteger(scope.index) || Number(scope.index) < 0 || Number(scope.index) > 1_000_000)) return undefined
  if (check.kind === 'output-equals' && shape(['kind', 'value']) && Object.hasOwn(check, 'value'))
    return { title: 'The final result must exactly match:', value: check.value, hasValue: true }
  if (check.kind === 'failure-code' && shape(['kind', 'value']) && typeof check.value === 'string' && Object.hasOwn(failures, check.value))
    return { title: failures[check.value]!, code: check.value, hasValue: false }
  if (!node(check.nodeId)) return undefined
  const context = scope ? `In round ${Number(scope.index) + 1} of loop “${scope.loop}”.` : undefined
  if (check.kind === 'node-visited' && shape(['kind', 'nodeId', 'scope']))
    return { title: `Step “${check.nodeId}” must have a saved result.`, context, hasValue: false }
  if (check.kind === 'node-output-equals' && shape(['kind', 'nodeId', 'scope', 'value']) && Object.hasOwn(check, 'value'))
    return { title: `The saved result of step “${check.nodeId}” must exactly match:`, context, value: check.value, hasValue: true }
  if (check.kind === 'node-port-equals' && shape(['kind', 'nodeId', 'scope', 'value']) && node(check.value))
    return { title: `Step “${check.nodeId}” must choose branch “${check.value}”.`, context, hasValue: false,
      help: 'This checks the saved branch choice, not whether the following step finished.' }
  return undefined
}
export function SavedTestChecks({ expectations }: { expectations: unknown }) {
  if (!Array.isArray(expectations) || expectations.length > 64) return <p>Extra checks could not be displayed safely. Review the exact saved definition.</p>
  const checks = expectations.filter(check => record(check)?.kind !== 'status')
  if (!checks.length) return null
  return <section className="saved-test-checks" aria-label="Additional saved checks">
    <span className="value-label">Also check</span>
    <ol>{checks.map((check, index) => {
      const description = describe(check)
      return <li key={index}>{description ? <>
        <p className="saved-check-title">{description.title}</p>
        {description.context && <p className="saved-check-context">{description.context}</p>}
        {description.hasValue && <RecordedValue value={description.value} />}
        {description.code && <code className="saved-check-code">{description.code}</code>}
        {description.help && <p className="value-help">{description.help}</p>}
      </> : <><p className="saved-check-title">This check needs technical review.</p><RecordedValue value={check} />
        <p className="value-help">Its meaning could not be safely summarized. Review the exact saved definition before accepting.</p></>}</li>
    })}</ol>
  </section>
}
