import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { compileWorkflowYaml } from '../src/workflow/compiler.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { CORE_VERSION } from '../src/capabilities.ts'

const execute = promisify(execFile)
const compiled = compileWorkflowYaml(await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8'), DEFAULT_COMPILER_LIMITS)
const snapshot = { format: 'jevable.ai/release', schemaVersion: 1, id: randomUUID(), version: '1.0.0',
  createdAt: new Date().toISOString(), createdBy: 'fixture', project: { id: randomUUID(), generation: 1 },
  workflow: { yaml: compiled.source.yaml, revision: compiled.source.revision }, runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } }

describe('release commands load usage reports only when selected', () => {
  it.each(['sqlite', 'postgres'] as const)('%s info does not import reports or ZIP machinery', async storage => {
    const result = await invoke(storage, ['info'])
    expect(result.code).toBe(0); expect(result.output).toMatchObject({ storage, execution: 'not-run' })
    expect(result.usageLoads).toBe(0); expect(result.files).toEqual([])
  })
  it.each(['sqlite', 'postgres'] as const)('%s unknown command does not import reports or ZIP machinery', async storage => {
    const result = await invoke(storage, ['invented-command'])
    expect(result.code).toBe(2); expect(result.error).toMatchObject({ code: 'invalid-command' })
    expect(result.usageLoads).toBe(0); expect(result.files).toEqual([])
  })
  it.each(['sqlite', 'postgres'] as const)('%s refuses non-notification operations without report or owner loading', async storage => {
    const result = await invoke(storage, ['notify'], { operation: 'runs.start', id: randomUUID(), input: {} })
    expect(result.code).toBe(2); expect(result.error).toMatchObject({ code: 'invalid-command' })
    expect(result.usageLoads).toBe(0); expect(result.files).toEqual(['command.json'])
  })
  it('valid SQLite notification history loads its owner without reports, evidence packaging or ZIP machinery', async () => {
    const result = await invoke('sqlite', ['notify'], { operation: 'notifications.list', page: {} }, false, true)
    expect(result.code).toBe(0); expect(result.usageLoads).toBe(0)
    expect(result.output).toMatchObject({ deliveries: [], nextCursor: null })
    expect(result.files).toContain('state'); expect(result.files).toContain('command.json')
    expect(await readdir(join(result.directory, 'state'))).not.toContain('runtime.lock')
  })
  it.each(['sqlite', 'postgres'] as const)('%s interruption during selected report loading prevents owner acquisition', async storage => {
    const result = await invoke(storage, ['usage', randomUUID()], undefined, true)
    expect(result.code).toBe(143); expect(result.usageLoads).toBe(1)
    expect(result.output).toBeNull(); expect(result.files).toEqual([])
    expect(result.error).toMatchObject({ status: 'draining', signal: 'SIGTERM', execution: 'not-cancelled' })
  })
})

async function invoke(storage: 'sqlite' | 'postgres', argv: string[], command?: object, interrupt = false, owner = false) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-release-report-loading-'))
  if (command !== undefined) { const file = join(directory, 'command.json'); await writeFile(file, JSON.stringify(command)); argv = [...argv, file] }
  if (owner) argv = [...argv, '--data-dir', join(directory, 'state')]
  const entry = new URL(storage === 'sqlite' ? '../src/releases/entry.ts' : '../src/releases/postgres-entry.ts', import.meta.url).href
  const program = `
    import {registerHooks} from 'node:module';
    let usageLoads=0;
    const hook=registerHooks({load(url,context,next){
      if (/\\/src\\/evidence\\/usage\\.ts$/.test(url)) {
        usageLoads++;
        if (${interrupt}) process.emit('SIGTERM','SIGTERM');
        else throw Error('Unselected report adapter loaded');
      }
      if (!${interrupt} && (/\\/src\\/evidence\\/(package|download)\\.ts$/.test(url)
        || /\\/node_modules\\/fflate\\//.test(url))) throw Error('Unselected evidence/ZIP module loaded');
      if (!${owner} && (url==='node:sqlite' || /\\/node_modules\\/pg\\//.test(url)
        || /\\/src\\/runtime\\/(local|postgres)\\.ts$/.test(url)
        || /\\/src\\/http\\/(service|server|postgres)\\.ts$/.test(url))) throw Error('Unselected owner loaded');
      return next(url,context);
    }});
    const {releaseMain}=await import(${JSON.stringify(entry)});
    await new Promise(resolve=>setImmediate(resolve));
    let output='',error='';const stdout=process.stdout.write,stderr=process.stderr.write;
    process.stdout.write=(value,done)=>{output+=String(value);queueMicrotask(()=>done?.(null));return true;};process.stderr.write=(value,done)=>{error+=String(value);queueMicrotask(()=>done?.(null));return true;};
    let code;try{code=await releaseMain(${JSON.stringify(snapshot)},${JSON.stringify(argv)},${JSON.stringify(directory)});}
    finally{process.stdout.write=stdout;process.stderr.write=stderr;hook.deregister();}
    const receipt=error.split('\\n').filter(line=>line.startsWith('{')).at(-1);
    console.log(JSON.stringify({code,usageLoads,output:output?JSON.parse(output):null,error:receipt?JSON.parse(receipt):null}));
  `
  const { stdout } = await execute(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', program],
    { cwd: directory, env: { PATH: '', TMPDIR: tmpdir(), LANG: 'en_US.UTF-8', TZ: 'UTC' } })
  return { ...JSON.parse(stdout), directory, files: await readdir(directory) }
}
