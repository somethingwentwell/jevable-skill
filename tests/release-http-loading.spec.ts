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

const execute = promisify(execFile)
const compiled = compileWorkflowYaml(await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8'), DEFAULT_COMPILER_LIMITS)
const snapshot = { format: 'jevable.ai/release', schemaVersion: 1, id: randomUUID(), version: '1.0.0',
  createdAt: new Date().toISOString(), createdBy: 'fixture', project: { id: randomUUID(), generation: 1 },
  workflow: { yaml: compiled.source.yaml, revision: compiled.source.revision },
  runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } }

describe('release entry selects HTTP before loading its client graph', () => {
  it.each(['sqlite', 'postgres'] as const)('%s info has no selected HTTP client or owner', async storage => {
    const result = await invoke(storage, ['info'])
    expect(result.code).toBe(0); expect(result.output).toMatchObject({ storage, execution: 'not-run' })
    expect(result.releaseClientLoads).toBe(0); expect(result.httpClientLoads).toBe(0); expect(result.files).toEqual([])
  })
  it.each(['sqlite', 'postgres'] as const)('%s unknown command avoids HTTP client and owner loading', async storage => {
    const result = await invoke(storage, ['unknown-command'])
    expect(result.code).toBe(2); expect(result.error).toMatchObject({ code: 'invalid-command' })
    expect(result.releaseClientLoads).toBe(0); expect(result.httpClientLoads).toBe(0); expect(result.files).toEqual([])
  })
  it.each(['sqlite', 'postgres'] as const)('%s invalid notification refuses before HTTP client, credential or owner loading', async storage => {
    const result = await invoke(storage, ['notify'], { operation: 'runs.start', id: randomUUID(), input: {} })
    expect(result.code).toBe(2); expect(result.error).toMatchObject({ code: 'invalid-command' })
    expect(result.releaseClientLoads).toBe(0); expect(result.httpClientLoads).toBe(0); expect(result.files).toEqual(['command.json'])
  })
  it.each(['sqlite', 'postgres'] as const)('%s interruption while status client loads refuses further file reads and dispatch', async storage => {
    const result = await invoke(storage, ['status', '--endpoint', 'http://127.0.0.1:1', '--token-file', 'never-read'], undefined, true)
    expect(result.code).toBe(143); expect(result.releaseClientLoads).toBe(1)
    expect(result.output).toBeNull(); expect(result.error).toMatchObject({ status: 'draining', signal: 'SIGTERM', execution: 'not-cancelled' })
    expect(result.files).toEqual([])
  })
  it.each(['sqlite', 'postgres'] as const)('%s interruption while request client loads refuses command/credential reads and dispatch', async storage => {
    const result = await invoke(storage, ['request', 'never-read-command', '--endpoint', 'http://127.0.0.1:1', '--token-file', 'never-read'], undefined, true)
    expect(result.code).toBe(143); expect(result.releaseClientLoads).toBe(1)
    expect(result.output).toBeNull(); expect(result.error).toMatchObject({ status: 'draining', signal: 'SIGTERM', execution: 'not-cancelled' })
    expect(result.files).toEqual([])
  })
  it('preserves the existing public HTTP error constructor and complete error fields', async () => {
    const client = await import('../src/http/client.ts'), publicHttp = await import('../src/http/index.ts')
    const errors = await import('../src/http/errors.ts')
    expect(client.RuntimeHttpError).toBe(errors.RuntimeHttpError); expect(publicHttp.RuntimeHttpError).toBe(errors.RuntimeHttpError)
    const error = new errors.RuntimeHttpError('rate-limit', 429, 17)
    expect(error).toBeInstanceOf(client.RuntimeHttpError); expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ name: 'RuntimeHttpError', code: 'rate-limit', status: 429, retryAfterSeconds: 17,
      message: 'Jevable HTTP operation failed: rate-limit. Inspect retained state before retrying a mutation; reuse the original run or request UUID.' })
  })
})

async function invoke(storage: 'sqlite' | 'postgres', argv: string[], command?: object, interrupt = false) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-release-http-loading-'))
  if (command !== undefined) {
    const file = join(directory, 'command.json'); await writeFile(file, JSON.stringify(command)); argv = [...argv, file]
  }
  const entry = new URL(storage === 'sqlite' ? '../src/releases/entry.ts' : '../src/releases/postgres-entry.ts', import.meta.url).href
  const program = `
    import {registerHooks} from 'node:module';
    let releaseClientLoads=0,httpClientLoads=0;
    const hook=registerHooks({load(url,context,next){
      if (/\\/src\\/releases\\/client\\.ts$/.test(url)) {
        releaseClientLoads++;
        if (${interrupt}) process.emit('SIGTERM', 'SIGTERM');
        else throw Error('Unselected release HTTP client loaded');
      }
      if (/\\/src\\/http\\/client\\.ts$/.test(url)) {
        httpClientLoads++;
        if (!${interrupt}) throw Error('Unselected HTTP transport graph loaded');
      }
      if (url==='node:sqlite' || /\\/node_modules\\/pg\\//.test(url)
        || /\\/src\\/runtime\\/(local|postgres)\\.ts$/.test(url)
        || /\\/src\\/http\\/(service|server|postgres)\\.ts$/.test(url)) throw Error('Unselected owner loaded');
      return next(url,context);
    }});
    const {releaseMain}=await import(${JSON.stringify(entry)});
    await new Promise(resolve=>setImmediate(resolve));
    let output='',error='';const stdout=process.stdout.write,stderr=process.stderr.write;
    process.stdout.write=(value,done)=>{output+=String(value);queueMicrotask(()=>done?.(null));return true;};
    process.stderr.write=(value,done)=>{error+=String(value);queueMicrotask(()=>done?.(null));return true;};
    let code;
    try {code=await releaseMain(${JSON.stringify(snapshot)},${JSON.stringify(argv)},${JSON.stringify(directory)});}
    finally {process.stdout.write=stdout;process.stderr.write=stderr;hook.deregister();}
    console.log(JSON.stringify({code,releaseClientLoads,httpClientLoads,output:output?JSON.parse(output):null,error:error?JSON.parse(error):null}));
  `
  const { stdout } = await execute(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', program],
    { cwd: directory, env: { PATH: '', TMPDIR: tmpdir(), LANG: 'en_US.UTF-8', TZ: 'UTC' } })
  return { ...JSON.parse(stdout), files: await readdir(directory) }
}
