/** Existing stream doubles acknowledge the same write callback as a native writable. */
export function acknowledgeCliWrite(capture: (value: string) => void = () => {}): typeof process.stdout.write {
  return ((value: Uint8Array | string, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void) => {
    capture(String(value))
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    if (done) queueMicrotask(() => done(null))
    return true
  }) as typeof process.stdout.write
}
