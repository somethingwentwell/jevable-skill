type JobSignal = 'SIGINT' | 'SIGTERM'
type Signals = {
  on(event: JobSignal, listener: () => void): unknown
  removeListener(event: JobSignal, listener: () => void): unknown
}

export class JobInterruptedError extends Error {
  constructor() { super('Local CLI shutdown has stopped further dispatch; inspect retained identities before retrying.') }
}

/** An executable job owns signals only while opening, using or closing its direct SDK owner.
 * Signal reception never calls cancel, close or another operation concurrently with admitted work.
 * SDK imports, selected-owner callers and dedicated service/suite/watch lifetimes are unaffected.
 */
export class JobLifetime {
  private holds = 0
  private signal: JobSignal | undefined
  private readonly int = () => this.interrupt('SIGINT')
  private readonly term = () => this.interrupt('SIGTERM')

  constructor(private readonly report: (receipt: unknown) => void, private readonly signals: Signals = process) {}

  get exitCode(): 130 | 143 | undefined { return this.signal === 'SIGINT' ? 130 : this.signal === 'SIGTERM' ? 143 : undefined }

  private interrupt(signal: JobSignal) {
    if (this.signal) return
    this.signal = signal
    this.report({ schemaVersion: 1, status: 'draining', signal, execution: 'not-cancelled',
      message: 'Waiting for admitted local work and owner cleanup. Repeated signals do not force termination.' })
  }

  assertAdmission() { if (this.signal) throw new JobInterruptedError() }

  hold(): () => void {
    this.assertAdmission()
    if (this.holds++ === 0) {
      this.signals.on('SIGINT', this.int)
      this.signals.on('SIGTERM', this.term)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.holds === 0) this.dispose()
    }
  }

  dispose() {
    this.signals.removeListener('SIGINT', this.int)
    this.signals.removeListener('SIGTERM', this.term)
  }
}
