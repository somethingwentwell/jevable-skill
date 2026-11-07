import { resolve } from 'node:path'
import { localRuntimeOptions } from '../telemetry/options.ts'
import { runReleaseApp, type ReleaseBackend } from './app.ts'

/** SQLite release entry. Its bundle never imports a PostgreSQL driver. */
export const sqliteReleaseBackend: ReleaseBackend = {
  storage: 'sqlite',
  open: async (values, directory, release) => {
    const { LocalRuntime } = await import('../runtime/local.ts')
    const options = await localRuntimeOptions(values, resolve(directory, '.jevable'))
    return LocalRuntime.open({ ...options, ...(options.notifications?.automatic ? { startupRelease: release } : {}) })
  },
  serve: async (values, directory, options) => {
    const { startRuntimeService } = await import('../http/service.ts')
    return startRuntimeService({ ...options, runtime: await localRuntimeOptions(values, resolve(directory, '.jevable')) })
  },
}

export const releaseMain = (value: unknown, argv: string[], directory: string) => runReleaseApp(sqliteReleaseBackend, value, argv, directory)
