import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const execute = promisify(execFile)
const source = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const root = new URL('../src/', import.meta.url).href
const guard = `
  import { registerHooks } from 'node:module';
  let blocked = 0;
  registerHooks({ load(url, context, next) {
    if (/\\/node_modules\\/@opentelemetry\\/(sdk-[^/]+|resources|otlp-transformer)\\//.test(url)
      || /\\/src\\/telemetry\\/(traces|metrics|logs|probe|otlp|grpc)\\.ts$/.test(url)) {
      blocked++; throw Error('optional-collector-not-selected');
    }
    return next(url, context);
  }});
`
async function cold(program: string) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-optional-telemetry-'))
  const { stdout } = await execute(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e',
    `${guard}\nconst directory = ${JSON.stringify(directory)};\n${program}`],
  { cwd: directory, env: { PATH: '', TMPDIR: tmpdir(), LANG: 'en_US.UTF-8', TZ: 'UTC' } })
  return JSON.parse(stdout)
}

describe('optional collector loading in standalone runtimes', () => {
  it.each(['runtime/index.ts', 'storage/index.ts', 'telemetry/index.ts', 'runtime/postgres.ts'])('%s imports without the collector SDK or transport', async entry => {
    const result = await cold(`await import(${JSON.stringify(root + entry)}); console.log(JSON.stringify({ blocked }));`)
    expect(result).toEqual({ blocked: 0 })
  })

  it('executes, retains and reopens a local workflow and returns disabled probes without loading exporters', async () => {
    const result = await cold(`
      const { LocalRuntime } = await import(${JSON.stringify(root + 'runtime/local.ts')});
      const { collectorProbeReportSchema } = await import(${JSON.stringify(root + 'telemetry/probe-report.ts')});
      const runtime = await LocalRuntime.open({ dataDirectory: directory });
      const run = await runtime.run(${JSON.stringify(source)}, 'local-runtime-input');
      const probe = collectorProbeReportSchema.parse(await runtime.telemetryProbe());
      const status = runtime.telemetryStatus();
      await runtime.telemetryFlush(); await runtime.close();
      const reopened = await LocalRuntime.open({ dataDirectory: directory });
      const retained = await reopened.show(run.id);
      await reopened.close();
      console.log(JSON.stringify({ blocked, status, probe, run: run.state, retained: retained.state }));
    `)
    expect(result.blocked).toBe(0)
    expect(result.status).toEqual({ enabled: false, signals: [] })
    expect(result.probe).toMatchObject({ status: 'disabled', protocol: null, signals: [], trace: null, execution: 'not-run', retries: false })
    expect(result.run).toMatchObject({ status: 'completed', output: 'local-runtime-input' })
    expect(result.retained).toEqual(result.run)
  })

  it('loads an explicitly selected pipeline and releases SQLite ownership if that import fails', async () => {
    const result = await cold(`
      const { LocalRuntime } = await import(${JSON.stringify(root + 'runtime/local.ts')});
      let error;
      try { await LocalRuntime.open({ dataDirectory: directory, telemetry: { endpoint: 'http://127.0.0.1:9/v1/traces', authentication: { kind: 'none' } } }); }
      catch (failure) { error = failure.message; }
      const runtime = await LocalRuntime.open({ dataDirectory: directory });
      const run = await runtime.run(${JSON.stringify(source)}, 'after-import-failure');
      await runtime.close();
      console.log(JSON.stringify({ blocked, error, run: run.state }));
    `)
    expect(result.blocked).toBe(1)
    expect(result.error).toBe('optional-collector-not-selected')
    expect(result.run).toMatchObject({ status: 'completed', output: 'after-import-failure' })
  })

  it('refuses invalid telemetry before loading exporters or creating SQLite state', async () => {
    const result = await cold(`
      const { readdir } = await import('node:fs/promises');
      const { LocalRuntime } = await import(${JSON.stringify(root + 'runtime/local.ts')});
      let code;
      try { await LocalRuntime.open({ dataDirectory: directory, telemetry: { authentication: { kind: 'invented' } } }); }
      catch (failure) { code = failure.code; }
      console.log(JSON.stringify({ blocked, code, files: await readdir(directory) }));
    `)
    expect(result).toEqual({ blocked: 0, code: 'invalid-command', files: [] })
  })
})
