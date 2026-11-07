import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { compileWorkflowYaml } from '../src/workflow/index.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { inspectRelease } from '../src/releases/snapshot.ts'

const execute = promisify(execFile)
const compiled = compileWorkflowYaml(await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8'), DEFAULT_COMPILER_LIMITS)
const snapshot = inspectRelease({ format: 'jevable.ai/release', schemaVersion: 1, id: randomUUID(), version: '1.0.0',
  createdAt: new Date().toISOString(), createdBy: 'fixture', project: { id: randomUUID(), generation: 1 },
  workflow: { yaml: compiled.source.yaml, revision: compiled.source.revision },
  runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } }).snapshot

// A real cold source-entry process, not a static import-string or mocked backend check.
// These guards exercise inert commands only; packaged service/job behavior is tested separately.
describe('release entries defer unselected database and server modules', () => {
  it.each(['sqlite', 'postgres'] as const)('%s rejects non-notification operations without importing a database owner or creating state', async storage => {
    const command = { operation: 'runs.start', id: randomUUID(), input: {} }
    const result = await invoke(storage, ['notify'], command)
    expect(result.code).toBe(2); expect(result.output).toBeNull()
    expect(result.error).toMatchObject({ status: 'error', code: 'invalid-command' })
    expect(result.createdFiles).toEqual(['command.json'])
    expect(result.commandContents).toBe(JSON.stringify(command))
  })
  it.each(['sqlite', 'postgres'] as const)('%s info reads the release without loading an owner, driver or viewer', async storage => {
    const result = await invoke(storage, ['info'])
    expect(result.code).toBe(0)
    expect(result.output).toMatchObject({ storage, execution: 'not-run', dockerRequired: false })
    expect(result.createdFiles).toEqual([])
  })
  it.each(['sqlite', 'postgres'] as const)('%s refuses an unknown action before loading an owner or viewer', async storage => {
    const result = await invoke(storage, ['not-a-command'])
    expect(result.code).toBe(2)
    expect(result.output).toBeNull()
    expect(result.error).toMatchObject({ status: 'error', code: 'invalid-command' })
    expect(result.createdFiles).toEqual([])
  })
  it.each(['sqlite', 'postgres'] as const)('%s refuses an unknown info flag without loading an owner or viewer', async storage => {
    const result = await invoke(storage, ['info', '--invented-flag'])
    expect(result.code).toBe(2)
    expect(result.output).toBeNull()
    expect(result.error).toMatchObject({ status: 'error', code: 'invalid-command' })
    expect(result.createdFiles).toEqual([])
  })
})

async function invoke(storage: 'sqlite' | 'postgres', argv: string[], command?: object) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-inert-release-entry-'))
  const commandFile = join(directory, 'command.json')
  if (command !== undefined) { await writeFile(commandFile, JSON.stringify(command)); argv = [...argv, commandFile] }
  const entry = new URL(storage === 'sqlite' ? '../src/releases/entry.ts' : '../src/releases/postgres-entry.ts', import.meta.url).href
  const program = `
    import { registerHooks } from 'node:module';
    const hook = registerHooks({ load(url, context, next) {
      if (/\\/node_modules\\/@opentelemetry\\/(sdk-[^/]+|resources|otlp-transformer)\\//.test(url)
        || /\\/src\\/telemetry\\/(traces|metrics|logs|probe|otlp|grpc)\\.ts$/.test(url)) throw Error('Unselected collector pipeline loaded: ' + url);
      if (url === 'node:sqlite' || /\\/node_modules\\/pg\\//.test(url)
        || /\\/src\\/runtime\\/(local|postgres)\\.ts$/.test(url)
        || /\\/src\\/http\\/(service|server|postgres)\\.ts$/.test(url)
        || /\\/src\\/preview\\//.test(url)) throw Error('Unselected owner/server module loaded: ' + url);
      return next(url, context);
    }});
    const { releaseMain } = await import(${JSON.stringify(entry)});
    // Keep Node's queued transform warning on real stderr before capturing the app's JSON receipt.
    await new Promise(resolve => setImmediate(resolve));
    let output = '', error = '';
    const stdout = process.stdout.write, stderr = process.stderr.write;
    process.stdout.write = (value, done) => { output += String(value); queueMicrotask(() => done?.(null)); return true; };
    process.stderr.write = (value, done) => { error += String(value); queueMicrotask(() => done?.(null)); return true; };
    let code;
    try { code = await releaseMain(${JSON.stringify(snapshot)}, ${JSON.stringify(argv)}, ${JSON.stringify(directory)}); }
    finally { process.stdout.write = stdout; process.stderr.write = stderr; hook.deregister(); }
    console.log(JSON.stringify({ code, output: output ? JSON.parse(output) : null, error: error ? JSON.parse(error) : null }));
  `
  const { stdout } = await execute(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', program],
    { cwd: directory, env: { PATH: '', TMPDIR: tmpdir(), LANG: 'en_US.UTF-8', TZ: 'UTC' } })
  return { ...JSON.parse(stdout), createdFiles: await readdir(directory),
    ...(command === undefined ? {} : { commandContents: await readFile(commandFile, 'utf8') }) }
}
