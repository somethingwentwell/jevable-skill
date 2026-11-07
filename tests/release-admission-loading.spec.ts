import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, mkdtemp, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compileWorkflowYaml } from '../src/workflow/compiler.ts'
import { DEFAULT_COMPILER_LIMITS } from '../src/limits.ts'
import { CORE_VERSION } from '../src/capabilities.ts'
import { inspectRelease, releaseRequirements } from '../src/releases/snapshot.ts'
import * as admission from '../src/runtime/admission.ts'
import * as evaluator from '../src/runtime/run-evaluator.ts'
import * as metadata from '../src/runtime/breakpoint-metadata.ts'
import * as breakpoints from '../src/runtime/breakpoints.ts'
import { WorkflowSourceError } from '../src/workflow/errors.ts'

const execute = promisify(execFile)
async function release(example: string) {
  const graph = compileWorkflowYaml(await readFile(new URL('../examples/' + example + '.yaml', import.meta.url), 'utf8'), DEFAULT_COMPILER_LIMITS)
  return inspectRelease({ format: 'jevable.ai/release', schemaVersion: 1, id: randomUUID(), version: '1.0.0',
    createdAt: new Date().toISOString(), createdBy: 'fixture', project: { id: randomUUID(), generation: 1 },
    workflow: { yaml: graph.source.yaml, revision: graph.source.revision }, runtime: { version: CORE_VERSION, sha256: 'a'.repeat(64) } })
}

describe('release static admission is independent of execution', () => {
  it('preserves exact legacy function identities rather than separate admission or receipt implementations', () => {
    for (const name of ['LOCAL_PLAN_KINDS', 'planKinds', 'compileRuntimeWorkflow', 'executionModelPlans'] as const) expect(evaluator[name]).toBe(admission[name])
    for (const name of ['breakpointConfiguration', 'breakpointAt', 'breakpointMetadata'] as const) expect(breakpoints[name]).toBe(metadata[name])
  })

  it('retains complete graph, explicit owner limits, trigger and AI-budget admission', async () => {
    const value = await release('echo'), source = value.snapshot.workflow.yaml
    expect(admission.compileRuntimeWorkflow(source, DEFAULT_COMPILER_LIMITS).source.revision).toBe(value.snapshot.workflow.revision)
    expect(() => admission.compileRuntimeWorkflow(source, { ...DEFAULT_COMPILER_LIMITS,
      source: { ...DEFAULT_COMPILER_LIMITS.source, maxNodes: 1 } })).toThrow(WorkflowSourceError)
    expect(() => admission.compileRuntimeWorkflow(source.replace('manual', 'webhook'), DEFAULT_COMPILER_LIMITS)).toThrow('invalid-command')
    const document = compileWorkflowYaml(source, DEFAULT_COMPILER_LIMITS).source.document
    for (const maxAiSteps of [0, -1, 1.5, '1', null]) expect(() => admission.compileRuntimeWorkflow(JSON.stringify({ ...document,
      extensions: { 'jevable.ai/budget': { maxAiSteps } } }), DEFAULT_COMPILER_LIMITS)).toThrow('invalid-command')
    const graph = admission.compileRuntimeWorkflow(JSON.stringify({ ...document, extensions: { 'jevable.ai/budget': { maxAiSteps: 1 } } }), DEFAULT_COMPILER_LIMITS)
    expect(admission.planKinds(graph.nodes)).toEqual(['trigger', 'output']); expect(admission.executionModelPlans(graph)).toEqual([])
  })

  it.each(['echo', 'approval', 'loop-approval'])('inspects %s and its full requirements without evaluator, provider protocol, telemetry API or vendor adapters', async example => {
    const expected = await release(example)
    const result = await cold(`
      const {inspectRelease,releaseRequirements}=await import(${JSON.stringify(new URL('../src/releases/snapshot.ts', import.meta.url).href)});
      const value=${JSON.stringify(expected.snapshot)},release=inspectRelease(value);
      let refusal;try{inspectRelease({...value,workflow:{...value.workflow,revision:'0'.repeat(64)}});}catch(error){refusal=error.code;}
      console.log(JSON.stringify({release,requirements:releaseRequirements(release.snapshot),refusal}));
    `)
    expect(result.output).toEqual({ release: expected, requirements: releaseRequirements(expected.snapshot), refusal: 'conflict' })
    expect(result.files).toEqual([])
  })

  it.each(['sqlite', 'postgres'] as const)('%s metadata and unknown actions do not load execution', async storage => {
    const expected = await release('echo')
    const entry = new URL(storage === 'sqlite' ? '../src/releases/entry.ts' : '../src/releases/postgres-entry.ts', import.meta.url).href
    const result = await cold(`
      const {releaseMain}=await import(${JSON.stringify(entry)});
      await new Promise(resolve=>setImmediate(resolve));
      let out='',err='';const stdout=process.stdout.write,stderr=process.stderr.write;
      process.stdout.write=(value,done)=>{out+=String(value);queueMicrotask(()=>done?.(null));return true;};process.stderr.write=(value,done)=>{err+=String(value);queueMicrotask(()=>done?.(null));return true;};
      let info,refusal;try{info=await releaseMain(${JSON.stringify(expected.snapshot)},['info'],process.cwd());refusal=await releaseMain(${JSON.stringify(expected.snapshot)},['not-a-command'],process.cwd());}
      finally{process.stdout.write=stdout;process.stderr.write=stderr;}
      console.log(JSON.stringify({info,refusal,metadata:JSON.parse(out),error:JSON.parse(err)}));
    `)
    expect(result.output).toMatchObject({ info: 0, refusal: 2, metadata: { execution: 'not-run', storage, releaseSha256: expected.sha256 }, error: { code: 'invalid-command' } })
    expect(result.files).toEqual([])
  })
})

async function cold(program: string) {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-release-admission-loading-'))
  // These are real source modules, not replacement implementations. Forbidden
  // loading fails the child before any operation can produce a passing result.
  const hook = `import{registerHooks}from'node:module';registerHooks({load(url,context,next){
    if(/\\/src\\/runtime\\/(run-evaluator|model-format|run-telemetry|local|postgres)\\.ts$/.test(url)
      || /\\/src\\/workflow\\/import\\//.test(url) || /\\/src\\/providers\\/systemone\\.ts$/.test(url)
      || /\\/node_modules\\/@opentelemetry\\/api\\//.test(url) || url==='node:sqlite'
      || /\\/node_modules\\/pg\\//.test(url)) throw Error('Execution-only module loaded during static admission: '+url);
    return next(url,context);}});`
  const { stdout } = await execute(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', hook + program],
    { cwd: directory, env: { PATH: '', TMPDIR: tmpdir(), LANG: 'en_US.UTF-8', TZ: 'UTC' } })
  return { output: JSON.parse(stdout), files: await readdir(directory) }
}
