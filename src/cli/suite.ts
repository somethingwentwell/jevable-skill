import { readBoundedFile, writeArtifact } from '../files.ts'
import { createTestSuite, inspectTestSuite, runTestSuite, testSuiteResult, TEST_SUITE_MAX_BYTES, type TestSuiteHost, type TestSuiteSelection } from '../testing/suite.ts'
import { RuntimeClient } from '../http/client.ts'
import { createHttpTestSuiteHost } from '../testing/http.ts'
import { readSecretFile } from '../providers/secret-input.ts'
import { readTlsPemFile } from '../http/tls.ts'
import { openCliRuntime, CliStorageUsageError, type CliValues } from './runtime.ts'
import { openCliOperations, operationSelection } from './operations.ts'
import { readCliTraceContext } from './trace-context.ts'
import { suiteTelemetrySelection, readSuiteTelemetryOptions } from './suite-telemetry.ts'
import { createTestSuiteTelemetry, type TestSuiteTelemetry } from '../testing/telemetry.ts'
import { createOperationTestSuiteHost } from '../testing/operation-host.ts'
import { testSuiteCoverage } from '../testing/coverage.ts'
import { compileWorkflowYaml } from '../workflow/index.ts'
import { DEFAULT_COMPILER_LIMITS } from '../limits.ts'

/** Preserve the suite's explicit loopback-HTTP mode; never read the manifest to select an owner. */
export function suiteSelection(values: CliValues): 'selected' | 'http' | 'local' {
  const selected = (selection: 'selected' | 'http' | 'local') => { suiteTelemetrySelection(values, selection); return selection }
  if (values.runtime === 'docker' || (values.endpoint !== undefined && (typeof values.endpoint !== 'string' || !/^http:/iu.test(values.endpoint)))) {
    operationSelection(values)
    return selected('selected')
  }
  if (values.endpoint !== undefined) {
    if (values['instance-id'] !== undefined) throw new CliStorageUsageError('--instance-id requires the HTTPS management endpoint selector.')
    if (['runtime', 'owner-file', 'owner-sha256', 'container-id'].some(key => values[key] !== undefined)) throw new CliStorageUsageError('Choose an endpoint or runtime owner selection, not both.')
    if (['data-dir', 'storage', 'database-file', 'telemetry-file'].some(key => values[key] !== undefined)) throw new CliStorageUsageError('Use an explicit endpoint or direct storage, not both.')
    if (typeof values['token-file'] !== 'string' || !values['token-file']) throw new CliStorageUsageError('Provide --token-file.')
    const raw = values['timeout-ms'], timeout = raw === undefined ? 30000 : Number(raw)
    if (raw !== undefined && (typeof raw !== 'string' || !/^[1-9][0-9]*$/u.test(raw) || !Number.isInteger(timeout) || timeout > 3600000)) throw new CliStorageUsageError('Timeout must be 1–3600000 milliseconds.')
    return selected('http')
  }
  operationSelection(values)
  return selected('local')
}

export async function suiteFromCli(action: 'create' | 'inspect' | 'run' | 'result' | 'coverage', path: string, values: CliValues, emit: (value: unknown) => void) {
  const required = (key: string) => { const value = values[key]; if (typeof value !== 'string' || !value) throw new CliStorageUsageError(`Provide --${key}.`); return value }
  if (action === 'create') {
    const output = required('output')
    const prepared = createTestSuite(JSON.parse(await readBoundedFile(path, TEST_SUITE_MAX_BYTES)) as TestSuiteSelection)
    const artifact = await writeArtifact(output, JSON.stringify(prepared.suite, null, 2) + '\n', values.overwrite === true)
    emit({ schemaVersion: 1, ...prepared, artifact, execution: 'not-requested', acceptance: 'not-checked' }); return 0
  }
  const selection = action === 'inspect' ? undefined : suiteSelection(values)
  const prepared = inspectTestSuite(JSON.parse(await readBoundedFile(path, TEST_SUITE_MAX_BYTES)))
  if (action === 'inspect') { emit({ schemaVersion: 1, ...prepared, execution: 'not-requested', acceptance: 'not-checked' }); return 0 }
  const source = action === 'coverage' ? await readBoundedFile(required('file'), DEFAULT_COMPILER_LIMITS.source.maxSourceBytes) : undefined
  // Reject invalid source before opening storage, loading owner credentials or contacting a service.
  if (source !== undefined) compileWorkflowYaml(source, DEFAULT_COMPILER_LIMITS)
  const reviewed = action === 'run' ? required('suite-sha256') : undefined
  if (reviewed !== undefined && reviewed !== prepared.sha256) throw new CliStorageUsageError('Suite hash differs from the reviewed manifest; inspect and review it before execution.')
  const context = await readCliTraceContext(values['trace-context-file'])
  const clientTelemetry = selection === 'local' ? undefined : await readSuiteTelemetryOptions(values)
  let telemetry: TestSuiteTelemetry | undefined
  let host: TestSuiteHost, close: (() => Promise<void>) | undefined
  let scope = <T>(work: () => Promise<T>): Promise<T> => work()
  try {
    if (clientTelemetry) telemetry = createTestSuiteTelemetry(clientTelemetry.config,
      clientTelemetry.credential ? { credential: clientTelemetry.credential } : {})
    if (selection === 'selected') {
      // Context was already captured once before credentials; every operation gets an explicit carrier below.
      const owner = await openCliOperations({ ...values, 'trace-context-file': undefined })
      host = createOperationTestSuiteHost(owner, context, telemetry)
      close = () => owner.close()
    } else if (selection === 'http') {
      // Preserve the existing explicit loopback HTTP suite API. General remote selection is HTTPS-only.
      const endpoint = required('endpoint'), token = await readSecretFile(required('token-file'))
      const ca = values['ca-file'] === undefined ? undefined : await readTlsPemFile(required('ca-file'))
      const raw = values['timeout-ms'], timeout = raw === undefined ? 30000 : Number(raw)
      host = createHttpTestSuiteHost(new RuntimeClient(endpoint, token, timeout, 20_000_000, ca === undefined ? {} : { ca }), context, telemetry)
    } else {
      const owner = await openCliRuntime(values)
      host = owner.runtime
      if (context !== undefined) scope = work => owner.runtime.withTraceContext(context, work)
      close = () => owner.runtime.close()
    }
    const controller = new AbortController(); let interruptExit = 130
    const int = () => { interruptExit = 130; controller.abort() }, term = () => { interruptExit = 143; controller.abort() }
    process.on('SIGINT', int); process.on('SIGTERM', term)
    try {
      if (action === 'coverage') {
        const report = await scope(() => testSuiteCoverage(host, prepared.suite, source!, { signal: controller.signal }))
        emit(report); return report.observationStatus === 'interrupted' ? interruptExit : report.entries.some(entry => entry.error) ? 1 : 0
      }
      const report = await scope(() => action === 'run' ? runTestSuite(host, prepared.suite, reviewed!, { signal: controller.signal }) : testSuiteResult(host, prepared.suite))
      emit(report)
      if (action === 'result') return report.status === 'blocked' ? 1 : 0
      return { passed: 0, failed: 6, pending: 3, attention: 3, uncertain: 5, blocked: 1, interrupted: interruptExit }[report.status]
    } finally { process.off('SIGINT', int); process.off('SIGTERM', term) }
  } finally {
    try { await close?.() } finally { try { await telemetry?.close() } catch { /* Diagnostic shutdown cannot replace the result/error. */ } }
  }
}
