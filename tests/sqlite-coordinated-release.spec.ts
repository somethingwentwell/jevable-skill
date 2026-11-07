import {afterEach,describe,expect,it,vi} from 'vitest'
import {mkdtemp,readFile,writeFile,lstat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import * as zip from '../src/packages/release-zip.ts'
import {LocalRuntime} from '../src/runtime/local.ts'
import {runReleaseApp} from '../src/releases/app.ts'
import {sqliteReleaseBackend} from '../src/releases/entry.ts'
import {releaseCommandStrings,releaseCommandReference} from '../src/releases/commands.ts'
import {dispatchOperation} from '../src/http/operations.ts'
import {RuntimeClient} from '../src/http/client.ts'
import * as processLifetime from '../src/http/process.ts'
import {main} from '../src/cli.ts'
import {CORE_VERSION} from '../src/capabilities.ts'
import {unzipSync} from 'fflate'

const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex'),token='d'.repeat(64)
const bytes=Buffer.from('UNIT_ONLY_OPTIONAL_SQLITE_QUOTA_PROGRAM'),notices=Buffer.from('Unit-test notices')
const artifact:zip.ReleaseRuntimeArtifact={bytes,notices,storage:'sqlite',rateCoordinator:'postgres',identity:{version:CORE_VERSION,sha256:sha(bytes)}}
const metadata={storage:'sqlite',rateCoordinator:'postgres',sha256:sha(bytes),bytes:bytes.length,external:'node-builtins-only'}
function reader(m:unknown=metadata){return vi.fn(async(path:string,_max:number)=>path.endsWith('-runtime.mjs')?bytes:path.endsWith('-runtime.json')?Buffer.from(JSON.stringify(m)):notices)}
const cleanup:(()=>Promise<unknown>)[]=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.restoreAllMocks()})
async function fixture(){const directory=await mkdtemp(join(tmpdir(),'jevable-sqlite-quota-release-')),owner=await LocalRuntime.open({dataDirectory:join(directory,'authoring')})
  cleanup.push(()=>owner.close());const yaml=await readFile(new URL('../examples/echo.yaml',import.meta.url),'utf8'),project=owner.editProject({operation:'create',title:'Unit SQLite profile',yaml,actor:'fixture'})
  const release=owner.createRelease({projectId:project.id,revision:project.acceptedRevision,expectedGeneration:1,version:'1.0.0',runtime:artifact.identity,actor:'fixture'})
  const tokenFile=join(directory,'token');await writeFile(tokenFile,token,{mode:0o600});return{directory,owner,project,release,tokenFile}}
function io(){let stdout='',stderr='';return{out:(s:string)=>{stdout+=s},err:(s:string)=>{stderr+=s},stdout:()=>stdout,stderr:()=>stderr}}
const policy={requests:{capacity:3,refillTokens:1,refillIntervalMs:1000},controls:{capacity:2,refillTokens:1,refillIntervalMs:1000}}

describe('explicit optional SQLite workflow/PostgreSQL quota artifact (native export qualification separate)',()=>{
  it('loads only the explicit optional artifact with captured bytes/notices/profile and hash',async()=>{
    const read=reader(),loaded=await zip.loadReleaseRuntimeProfile({storage:'sqlite',rateCoordinator:'postgres'},read)
    expect(loaded).toEqual(artifact);expect(read.mock.calls.map(c=>c[0].split('/').pop())).toEqual(['release-sqlite-coordinated-runtime.mjs','release-sqlite-coordinated-runtime.json','release-sqlite-coordinated-NOTICES.txt'])
  })
  it('keeps default SQLite on the original artifact with no quota marker',async()=>{
    const read=reader({...metadata,rateCoordinator:undefined}),loaded=await zip.loadReleaseRuntime('sqlite',read)
    expect(loaded).not.toHaveProperty('rateCoordinator');expect(read.mock.calls[0]![0]).toMatch(/\/release-runtime\.mjs$/u)
  })
  it.each([{},null,{storage:'postgres',rateCoordinator:'postgres'},{storage:'sqlite'},{storage:'sqlite',rateCoordinator:'redis'},
    {storage:'sqlite',rateCoordinator:'postgres',password:'PRIVATE'},{storage:'sqlite',rateCoordinator:'postgres',initialize:true}])('refuses invalid profile before any artifact reads (%#)',async profile=>{
    const read=reader();await expect(zip.loadReleaseRuntimeProfile(profile as any,read)).rejects.toHaveProperty('code','invalid-command');expect(read).not.toHaveBeenCalled()
  })
  it.each([{...metadata,rateCoordinator:undefined},{...metadata,rateCoordinator:'redis'},{...metadata,storage:'postgres'},
    {...metadata,sha256:'a'.repeat(64)},{...metadata,bytes:bytes.length+1},{...metadata,external:'npm'}])('refuses metadata/profile/bytes disagreement (%#)',async m=>{
    const read=reader(m);await expect(zip.loadReleaseRuntimeProfile({storage:'sqlite',rateCoordinator:'postgres'},read)).rejects.toHaveProperty('code','corrupt');expect(read).toHaveBeenCalledTimes(2)
  })
  it('keeps optional serve flags separate from storage, client commands and ordinary SQLite',()=>{
    expect(releaseCommandStrings('serve','sqlite','postgres')).toContain('rate-coordinator-file');expect(releaseCommandStrings('serve','sqlite','postgres')).toContain('data-dir')
    expect(releaseCommandStrings('serve','sqlite','postgres')).not.toContain('database-file');expect(releaseCommandStrings('serve','sqlite')).not.toContain('rate-coordinator-file')
    for(const name of ['run','check','info','status','request'])expect(releaseCommandStrings(name,'sqlite','postgres')).not.toContain('rate-coordinator-file')
    expect(releaseCommandReference('sqlite','postgres')).toContain('direct jobs need no quota server')
  })
  it('exports the fixed allowlist with declared optional capability, pinned runtime and no configuration/extra driver files',async()=>{
    const f=await fixture(),files=unzipSync(zip.createReleaseZip(f.release,artifact)),manifest=JSON.parse(Buffer.from(files['manifest.json']!).toString())
    expect(Object.keys(files)).toHaveLength(12);expect(manifest.files).toHaveLength(11);expect(manifest).toMatchObject({storage:'sqlite',rateCoordinator:'postgres',runtime:artifact.identity})
    expect(JSON.parse(Buffer.from(files['configuration.json']!).toString())).toMatchObject({storage:'sqlite',rateCoordinator:'postgres'})
    expect(Buffer.from(files['README.txt']!).toString()).toContain('[--rate-coordinator-file <value>]');expect(Buffer.from(files['compose.yaml']!).toString()).toContain('workflow-data:/data')
    expect(Buffer.from(files['runtime.mjs']!)).toEqual(bytes);expect(JSON.stringify(manifest)).not.toContain(token)
    const {rateCoordinator:_profile,...plainArtifact}=artifact
    const plain=unzipSync(zip.createReleaseZip(f.release,plainArtifact));expect(JSON.parse(Buffer.from(plain['manifest.json']!).toString())).not.toHaveProperty('rateCoordinator')
  })
  it('refuses an unsupported capability or workflow-storage substitution in the artifact descriptor',async()=>{
    const f=await fixture();expect(()=>zip.createReleaseZip(f.release,{...artifact,rateCoordinator:'redis'} as any)).toThrow('invalid-command')
    expect(()=>zip.createReleaseZip(f.release,{...artifact,storage:'postgres'})).toThrow('invalid-command')
    expect(()=>zip.createReleaseZip(f.release,{...artifact,bytes:Buffer.from('replacement')})).toThrow('conflict')
  })
  it('publishes optional app info without preparing quota or acquiring storage',async()=>{
    const f=await fixture(),prepare=vi.fn(),open=vi.fn(),capture=io()
    expect(await runReleaseApp({...sqliteReleaseBackend,rateCoordinator:'postgres',prepareRateCoordinator:prepare,open},f.release.snapshot,['info'],f.directory,capture)).toBe(0)
    expect(JSON.parse(capture.stdout())).toMatchObject({storage:'sqlite',rateCoordinator:'postgres',databaseConfiguration:'local-data-directory',execution:'not-run'})
    expect(prepare).not.toHaveBeenCalled();expect(open).not.toHaveBeenCalled()
  })
  it('forwards trusted quota admission to a real SQLite HTTP owner and closes it only after HTTP drain',async()=>{
    const f=await fixture(),scope=randomUUID(),close=vi.fn(async()=>{}),consume=vi.fn(async(r:any)=>({requestId:r.requestId,scope:r.scope,policySha256:r.policySha256,lane:r.lane,admitted:true as const}))
    const prepare=vi.fn(async()=>async()=>({admission:()=>({scope,policy,timeoutMs:1000,consume}),close})),capture=io()
    vi.spyOn(processLifetime,'runServiceProcess').mockImplementation(async begin=>{const service=await begin();try{expect(close).not.toHaveBeenCalled()
      const client=new RuntimeClient(service.url,token),reply:any=await client.operation({operation:'runs.start',id:randomUUID(),input:'Unit paused',paused:true,releaseSha256:f.release.sha256} as any)
      expect(reply.result.status).toBe('paused');expect(reply.result.release.sha256).toBe(f.release.sha256);expect(consume).toHaveBeenCalledTimes(1)
    }finally{await service.close();await service.closed}expect(close).not.toHaveBeenCalled();return 0})
    expect(await runReleaseApp({...sqliteReleaseBackend,rateCoordinator:'postgres',prepareRateCoordinator:prepare},f.release.snapshot,
      ['serve','--token-file',f.tokenFile,'--data-dir',join(f.directory,'job'),'--rate-coordinator-file','trusted-backend-fixture'],f.directory,capture)).toBe(0)
    expect(close).toHaveBeenCalledTimes(1);expect(capture.stderr()).toBe('')
  })
  it('keeps optional direct jobs independent of the quota backend',async()=>{
    const f=await fixture(),prepare=vi.fn(),capture=io(),input=join(f.directory,'input.json');await writeFile(input,JSON.stringify('Independent direct job'))
    expect(await runReleaseApp({...sqliteReleaseBackend,rateCoordinator:'postgres',prepareRateCoordinator:prepare},f.release.snapshot,
      ['run','--data-dir',join(f.directory,'job'),'--input',input,'--id',randomUUID()],f.directory,capture)).toBe(0)
    expect(prepare).not.toHaveBeenCalled();expect(JSON.parse(capture.stdout()).output).toBe('Independent direct job')
  })
  it('rejects mixed local/shared flags before protected configuration or credentials',async()=>{
    const f=await fixture(),prepare=vi.fn(),open=vi.fn(),capture=io()
    expect(await runReleaseApp({...sqliteReleaseBackend,rateCoordinator:'postgres',prepareRateCoordinator:prepare,open},f.release.snapshot,
      ['serve','--token-file','not-read','--rate-coordinator-file','not-read','--rate-limits-file','not-read'],f.directory,capture)).toBe(2)
    expect(prepare).not.toHaveBeenCalled();expect(open).not.toHaveBeenCalled();expect(JSON.parse(capture.stderr()).code).toBe('invalid-command')
  })
  it('management creates only the requested installed optional runtime identity and retains SQLite authoring/workflow storage',async()=>{
    const f=await fixture(),load=vi.spyOn(zip,'loadReleaseRuntimeProfile').mockResolvedValue(artifact),id=randomUUID()
    const release:any=await dispatchOperation({storage:'sqlite',runtime:f.owner},{operation:'releases.create',id,projectId:f.project.id,expectedGeneration:1,revision:f.project.acceptedRevision,
      version:'2.0.0',runtimeStorage:'sqlite',runtimeRateCoordinator:'postgres',runtime:artifact.identity},'fixture:authenticated')
    expect(load).toHaveBeenCalledWith({storage:'sqlite',rateCoordinator:'postgres'});expect(release.snapshot.runtime).toEqual(artifact.identity);expect(release.snapshot.createdBy).toBe('fixture:authenticated');expect(f.owner.list()).toEqual([])
  })
  it('management refuses unsupported storage/profile and substituted runtime pins without release mutation',async()=>{
    const f=await fixture(),load=vi.spyOn(zip,'loadReleaseRuntimeProfile').mockResolvedValue(artifact),command={operation:'releases.create',id:randomUUID(),projectId:f.project.id,expectedGeneration:1,
      revision:f.project.acceptedRevision,version:'2.0.0',runtimeStorage:'postgres',runtimeRateCoordinator:'postgres',runtime:artifact.identity}
    await expect(dispatchOperation({storage:'sqlite',runtime:f.owner},command,'fixture')).rejects.toHaveProperty('code','invalid-command');expect(load).not.toHaveBeenCalled()
    await expect(dispatchOperation({storage:'sqlite',runtime:f.owner},{...command,runtimeStorage:'sqlite',runtime:{...artifact.identity,sha256:'a'.repeat(64)}},'fixture')).rejects.toHaveProperty('code','conflict')
    expect(f.owner.releases()).toHaveLength(1)
  })
  it.each([['postgres','postgres'],['sqlite','redis'],[undefined,'postgres']])('CLI refuses invalid profile selection before owner acquisition (%s/%s)',async(storage,coordinator)=>{
    const dir=await mkdtemp(join(tmpdir(),'jevable-invalid-profile-')),open=vi.spyOn(LocalRuntime,'open'),capture=io()
    expect(await main(['releases','create',randomUUID(),'--revision','a'.repeat(64),'--expected-generation','1','--version','1.0.0',
      ...(storage?['--runtime-storage',storage]:[]),'--runtime-rate-coordinator',coordinator!,'--data-dir',join(dir,'never-created')],capture)).toBe(2)
    expect(open).not.toHaveBeenCalled();await expect(lstat(join(dir,'never-created'))).rejects.toHaveProperty('code','ENOENT')
  })
  it('CLI creates the explicit optional SQLite profile with a retained release identity',async()=>{
    const f=await fixture();await f.owner.close();cleanup.pop();const load=vi.spyOn(zip,'loadReleaseRuntimeProfile').mockResolvedValue(artifact),capture=io(),id=randomUUID()
    expect(await main(['releases','create',f.project.id,'--id',id,'--revision',f.project.acceptedRevision,'--expected-generation','1','--version','2.0.0',
      '--runtime-storage','sqlite','--runtime-rate-coordinator','postgres','--data-dir',join(f.directory,'authoring')],capture)).toBe(0)
    expect(JSON.parse(capture.stdout())).toMatchObject({snapshot:{id,runtime:artifact.identity}});expect(load).toHaveBeenCalledTimes(2)
  })
})
