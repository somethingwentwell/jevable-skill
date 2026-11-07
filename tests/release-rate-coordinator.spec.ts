import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {mkdtemp,readFile,writeFile,chmod} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {CORE_VERSION} from '../src/capabilities.ts'
import {DEFAULT_COMPILER_LIMITS} from '../src/limits.ts'
import {compileWorkflowYaml} from '../src/workflow/index.ts'
import {inspectRelease} from '../src/releases/snapshot.ts'
import {releaseCommandStrings,releaseCommandReference} from '../src/releases/commands.ts'
import {releaseMain as postgresMain} from '../src/releases/postgres-entry.ts'
import {releaseMain as sqliteMain} from '../src/releases/entry.ts'
import {PostgresHttpRateCoordinatorError} from '../src/http/postgres-rate-config.ts'
import {RuntimeClient} from '../src/http/client.ts'
import {startRuntimeService} from '../src/http/service.ts'
import * as processes from '../src/http/process.ts'

const fake=vi.hoisted(()=>({open:vi.fn(),serve:vi.fn()}))
vi.mock('../src/http/postgres-rate-limits.ts',async()=>({PostgresHttpRateCoordinator:{open:fake.open},
  PostgresHttpRateCoordinatorError:(await import('../src/http/postgres-rate-config.ts')).PostgresHttpRateCoordinatorError}))
vi.mock('../src/http/postgres.ts',()=>({startPostgresRuntimeService:fake.serve}))
beforeEach(()=>{fake.open.mockReset();fake.serve.mockReset()})
afterEach(()=>{vi.restoreAllMocks()})
const token='e'.repeat(64),bucket={capacity:2,refillTokens:1,refillIntervalMs:1000}
const graph=compileWorkflowYaml(await readFile(new URL('../examples/echo.yaml',import.meta.url),'utf8'),DEFAULT_COMPILER_LIMITS)
const release=inspectRelease({format:'jevable.ai/release',schemaVersion:1,id:randomUUID(),version:'1.0.0',createdAt:new Date().toISOString(),
  createdBy:'fixture',project:{id:randomUUID(),generation:1},workflow:{yaml:graph.source.yaml,revision:graph.source.revision},
  runtime:{version:CORE_VERSION,sha256:'a'.repeat(64)}})
function config(){return{connection:{host:'127.0.0.1',port:54321,database:'fixture',user:'fixture',password:'PRIVATE_QUOTA_PASSWORD',tls:{mode:'loopback-test'}},
  scope:String(randomUUID()),policy:{requests:bucket,controls:{...bucket,capacity:3}},initialize:false,timeoutMs:1000,statementTimeoutMs:500,maxPendingDebits:4}}
async function fixture(value:unknown=config()){
  const directory=await mkdtemp(join(tmpdir(),'jevable-release-quota-')),quota=join(directory,'quota.json'),database=join(directory,'database.json'),tokenFile=join(directory,'token')
  await writeFile(quota,JSON.stringify(value),{mode:0o600});await writeFile(database,JSON.stringify({...config().connection,namespace:'fixture_namespace',initialize:false}),{mode:0o600})
  await writeFile(tokenFile,token,{mode:0o600})
  return{directory,quota,database,tokenFile,args:['serve','--token-file',tokenFile,'--database-file',database,'--rate-coordinator-file',quota]}
}
function capture(){let out='',err='';return{io:{out:(s:string)=>{out+=s},err:(s:string)=>{err+=s}},out:()=>out,err:()=>err}}
// Entries use native output; acknowledge its writer rather than replacing its async contract.
function output(){const c=capture();vi.spyOn(process.stdout,'write').mockImplementation((value:any,encoding:any,callback:any)=>{
  c.io.out(String(value));queueMicrotask(()=>{if(typeof encoding==='function')encoding(null);else callback?.(null)});return true})
  vi.spyOn(process.stderr,'write').mockImplementation((value:any,encoding:any,callback:any)=>{
    c.io.err(String(value));queueMicrotask(()=>{if(typeof encoding==='function')encoding(null);else callback?.(null)});return true});return c}
function owner(value=config()){
  const close=vi.fn(async()=>{}),consume=vi.fn(async(r:any)=>({requestId:r.requestId,scope:r.scope,policySha256:r.policySha256,lane:r.lane,admitted:true as const}))
  fake.open.mockResolvedValue({close,admission:()=>({scope:value.scope,policy:value.policy,timeoutMs:value.timeoutMs,consume})});return{close,consume}
}
describe('exact PostgreSQL release app quota startup (backend doubles, native packaging separate)',()=>{
  it('advertises the flag for PostgreSQL serve only and preserves the SQLite no-driver profile',()=>{
    expect(releaseCommandStrings('serve','postgres')).toContain('rate-coordinator-file')
    expect(releaseCommandStrings('serve','sqlite')).not.toContain('rate-coordinator-file')
    for(const action of ['info','run','request','observe','check'])expect(releaseCommandStrings(action,'postgres')).not.toContain('rate-coordinator-file')
    expect(releaseCommandReference('postgres')).toContain('initialize:false')
    expect(releaseCommandReference('sqlite')).toContain('imports no PostgreSQL driver')
  })
  it('pins private options before connection, forwards exact-release admission and closes quota after HTTP drain',async()=>{
    const value=config(),f=await fixture(value),o=owner(value),c=output()
    fake.serve.mockImplementation(async(options:any)=>startRuntimeService({...options,runtime:{dataDirectory:join(f.directory,'state')}}))
    vi.spyOn(processes,'runServiceProcess').mockImplementation(async begin=>{
      const service=await begin();expect(o.close).not.toHaveBeenCalled()
      try{const client=new RuntimeClient(service.url,token),cap:any=await client.capabilities()
        expect(cap.api.rateLimits.coordinator.scope).toBe(value.scope);expect(service.release?.sha256).toBe(release.sha256)
        await client.health();expect(o.consume).toHaveBeenCalledTimes(1)
      }finally{await service.close();await service.closed}expect(o.close).not.toHaveBeenCalled();return 0
    })
    expect(await postgresMain(release.snapshot,f.args,f.directory)).toBe(0)
    expect(fake.open).toHaveBeenCalledWith(value);expect(fake.serve).toHaveBeenCalledTimes(1);expect(fake.serve.mock.calls[0]![0]).not.toHaveProperty('rateLimits')
    expect(o.close).toHaveBeenCalledTimes(1);expect(c.err()).toBe('')
  })
  it('does not construct a coordinator for unselected service startup',async()=>{
    const f=await fixture(),c=output()
    fake.serve.mockImplementation(async(options:any)=>startRuntimeService({...options,runtime:{dataDirectory:join(f.directory,'state')}}))
    vi.spyOn(processes,'runServiceProcess').mockImplementation(async begin=>{const service=await begin();await service.close();await service.closed;return 0})
    expect(await postgresMain(release.snapshot,['serve','--token-file',f.tokenFile,'--database-file',f.database],f.directory)).toBe(0)
    expect(fake.open).not.toHaveBeenCalled();expect(c.err()).toBe('')
  })
  it('rejects mixed quota flags before either private quota or token read',async()=>{
    const c=output();expect(await postgresMain(release.snapshot,['serve','--token-file','not-read','--database-file','not-read',
      '--rate-limits-file','not-read','--rate-coordinator-file','not-read'],'/unused')).toBe(2)
    expect(JSON.parse(c.err()).code).toBe('invalid-command');expect(fake.open).not.toHaveBeenCalled();expect(fake.serve).not.toHaveBeenCalled()
  })
  it.each([{...config(),initialize:true},{...config(),extra:'PRIVATE'}, {...config(),timeoutMs:99},
    {...config(),maxPendingDebits:65},{...config(),scope:'bad'}, {...config(),connection:{...config().connection,host:'remote.invalid'}}])('refuses invalid private attachment before opening quota/workflow (%#)',async value=>{
    const f=await fixture(value),c=output();expect(await postgresMain(release.snapshot,f.args,f.directory)).toBe(2)
    expect(JSON.parse(c.err()).code).toBe('invalid-command');expect(fake.open).not.toHaveBeenCalled();expect(fake.serve).not.toHaveBeenCalled();expect(c.err()).not.toContain('PRIVATE')
  })
  it.skipIf(process.platform==='win32')('refuses public-readable configuration before connection',async()=>{
    const f=await fixture(),c=output();await chmod(f.quota,0o644);expect(await postgresMain(release.snapshot,f.args,f.directory)).toBe(2)
    expect(JSON.parse(c.err()).code).toBe('invalid-command');expect(fake.open).not.toHaveBeenCalled();expect(fake.serve).not.toHaveBeenCalled()
  })
  it('never opens quota when the required service token cannot be read',async()=>{
    const f=await fixture(),c=output();f.args[f.args.indexOf('--token-file')+1]=join(f.directory,'missing-token')
    expect(await postgresMain(release.snapshot,f.args,f.directory)).toBe(1);expect(fake.open).not.toHaveBeenCalled();expect(fake.serve).not.toHaveBeenCalled();expect(c.err()).not.toContain('PRIVATE')
  })
  it.each(['policy-conflict','uninitialized','commit-uncertain'] as const)('returns safe %s backend category and acquires no workflow owner',async code=>{
    const f=await fixture(),c=output();fake.open.mockRejectedValue(new PostgresHttpRateCoordinatorError(code))
    expect(await postgresMain(release.snapshot,f.args,f.directory)).toBe(1);expect(JSON.parse(c.err()).code).toBe(code);expect(fake.serve).not.toHaveBeenCalled()
  })
  it('does not adopt unknown driver text or category',async()=>{
    const f=await fixture(),c=output();fake.open.mockRejectedValue(Object.assign(Error('PRIVATE_ENDPOINT_PASSWORD'),{code:'PRIVATE_CATEGORY'}))
    expect(await postgresMain(release.snapshot,f.args,f.directory)).toBe(1);expect(JSON.parse(c.err()).code).toBe('unavailable');expect(c.err()).not.toContain('PRIVATE');expect(fake.serve).not.toHaveBeenCalled()
  })
  it('closes attached quota after workflow startup refusal',async()=>{
    const f=await fixture(),o=owner(),c=output();fake.serve.mockRejectedValue(Error('PRIVATE_WORKFLOW_FAILURE'))
    expect(await postgresMain(release.snapshot,f.args,f.directory)).toBe(1);expect(o.close).toHaveBeenCalledTimes(1);expect(c.err()).not.toContain('PRIVATE_WORKFLOW_FAILURE')
  })
  it('closes attached quota if the service lifetime fails after normal HTTP cleanup',async()=>{
    const f=await fixture(),o=owner(),c=output()
    fake.serve.mockImplementation(async(options:any)=>startRuntimeService({...options,runtime:{dataDirectory:join(f.directory,'state')}}))
    vi.spyOn(processes,'runServiceProcess').mockImplementation(async begin=>{const service=await begin();try{throw Error('PRIVATE_SINK_FAILURE')}finally{await service.close();await service.closed}})
    expect(await postgresMain(release.snapshot,f.args,f.directory)).toBe(1);expect(o.close).toHaveBeenCalledTimes(1);expect(c.err()).not.toContain('PRIVATE')
  })
  it('default SQLite entry refuses the unsupported selection before reading files',async()=>{
    const c=output();expect(await sqliteMain(release.snapshot,['serve','--token-file','not-read','--rate-coordinator-file','not-read'],'/unused')).toBe(2)
    expect(JSON.parse(c.err()).code).toBe('invalid-command');expect(fake.open).not.toHaveBeenCalled();expect(fake.serve).not.toHaveBeenCalled()
  })
})
