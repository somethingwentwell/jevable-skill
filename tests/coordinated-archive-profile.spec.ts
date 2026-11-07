import {afterEach,describe,expect,it,vi} from 'vitest'
import {basename,join} from 'node:path'
import {mkdtemp,readFile,lstat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {zipSync,unzipSync} from 'fflate'
import * as management from '../src/management/package.ts'
import * as skill from '../src/management/skill-package.ts'
import {inspectAgentSkillZip} from '../src/management/skill-inspection.ts'
import {CORE_VERSION} from '../src/capabilities.ts'
import {main} from '../src/cli.ts'

const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),profile={rateCoordinator:'postgres' as const}
function fixture(change?:(name:string,b:Buffer)=>Buffer){return vi.fn(async(path:string)=>{
  const name=basename(path),stem=name.replace(/-(?:runtime\.(?:mjs|json)|NOTICES\.txt)$/u,''),bytes=Buffer.from('throw Error("UNIT_ARCHIVE_CODE_NEVER_IMPORTED_'+stem+'")\n')
  const storage=stem==='core'?'management':stem==='release-postgres'?'postgres':'sqlite'
  const value=name.endsWith('-runtime.mjs')?bytes:name.endsWith('-runtime.json')?Buffer.from(JSON.stringify({schemaVersion:1,storage,
    external:'node-builtins-only',sha256:hash(bytes),bytes:bytes.length,...(storage==='management'?{coreVersion:CORE_VERSION}:{}),
    ...(stem==='release-sqlite-coordinated'?{rateCoordinator:'postgres'}:{})})):Buffer.from('UNIT_PUBLIC_RESOURCE '+name)
  return change?change(name,value):value
})}
function repack(input:Buffer,change:(files:Record<string,Uint8Array>)=>void){const files=unzipSync(input);change(files);return Buffer.from(zipSync(files))}
// Rebind metadata at BOTH manifest layers to exercise semantic checks beyond a stale file hash.
function changeMetadata(files:Record<string,Uint8Array>,patch:(m:any)=>void){const path='dist/release-sqlite-coordinated-runtime.json',full='jevable/'+path,
  metadata=JSON.parse(Buffer.from(files[full]!).toString());patch(metadata);files[full]=Buffer.from(JSON.stringify(metadata))
  const outer=JSON.parse(Buffer.from(files['jevable/manifest.json']!).toString()),inner=JSON.parse(Buffer.from(files['jevable/runtime-manifest.json']!).toString())
  for(const manifest of [inner,outer]){const f=manifest.files.find((f:any)=>f.path===path);f.bytes=files[full]!.length;f.sha256=hash(files[full]!)}
  files['jevable/runtime-manifest.json']=Buffer.from(JSON.stringify(inner));const f=outer.files.find((f:any)=>f.path==='runtime-manifest.json');f.bytes=files['jevable/runtime-manifest.json']!.length;f.sha256=hash(files['jevable/runtime-manifest.json']!)
  files['jevable/manifest.json']=Buffer.from(JSON.stringify(outer))
}
afterEach(()=>{vi.restoreAllMocks()})
describe('explicit optional quota delivery archive profiles',()=>{
  it('keeps omitted/empty options on the identical default schema-1 inventory and never reads optional assets',async()=>{
    const read=fixture(),a=await management.createManagementZip(read),b=await management.createManagementZip(fixture(),{})
    expect(b).toEqual(a);expect(a.manifest.schemaVersion).toBe(1);expect(a.manifest).not.toHaveProperty('rateCoordinator');expect(Object.keys(unzipSync(a.bytes))).toHaveLength(12)
    expect(read.mock.calls).toHaveLength(9);expect(read.mock.calls.every(c=>!c[0].includes('coordinated'))).toBe(true)
  })
  it('packs the explicit fourth runtime with a fixed schema-2 management inventory and metadata',async()=>{
    const read=fixture(),result=await management.createManagementZip(read,profile),files=unzipSync(result.bytes)
    expect(result.manifest).toMatchObject({schemaVersion:2,rateCoordinator:'postgres',state:'excluded',credentials:'excluded'})
    expect(result.manifest.runtimes.map(r=>r.role)).toEqual(['management','sqlite','postgres','sqlite-coordinated'])
    expect(Object.keys(files).sort()).toEqual([...management.MANAGEMENT_COORDINATED_PACKAGE_FILES,'manifest.json'].sort());expect(Object.keys(files)).toHaveLength(15);expect(read).toHaveBeenCalledTimes(12)
    for(const f of result.manifest.files){expect(files[f.path]!.length).toBe(f.bytes);expect(hash(files[f.path]!)).toBe(f.sha256)}
    expect(await management.createManagementZip(fixture(),profile)).toEqual(result)
  })
  it('inspects default and optional skills offline without importing the deliberately throwing programs',async()=>{
    for(const options of [{},profile]){const result=await skill.createAgentSkillZip(fixture(),options),inspection=await inspectAgentSkillZip(result.bytes,hash(result.bytes))
      expect(inspection).toMatchObject({schemaVersion:options===profile?2:1,status:'consistent',network:'none',state:'not-opened',execution:'not-started-by-inspection'})
      expect(inspection.runtimes).toHaveLength(options===profile?4:3);expect(inspection.files).toBe(result.manifest.files.length+1)
      const files=unzipSync(result.bytes);expect(Object.keys(files).length).toBe(management.MANAGEMENT_PACKAGE_FILES.length+skill.AGENT_SKILL_RESOURCES.length+2+(options===profile?3:0))
      expect(JSON.parse(Buffer.from(files['jevable/runtime-manifest.json']!).toString()).schemaVersion).toBe(result.manifest.schemaVersion)
    }
  })
  it.each([null,{rateCoordinator:'redis'},{rateCoordinator:'postgres',password:'PRIVATE'},{storage:'postgres'},{initialize:true}])('refuses unsupported archive options before any reads (%#)',async options=>{
    const read=fixture();await expect(management.createManagementZip(read,options as any)).rejects.toHaveProperty('code','invalid-command');expect(read).not.toHaveBeenCalled()
    await expect(skill.createAgentSkillZip(read,options as any)).rejects.toHaveProperty('code','invalid-command');expect(read).not.toHaveBeenCalled()
  })
  it.each(['storage','rateCoordinator','sha256','bytes','external'])('refuses inconsistent optional %s metadata before publication',async field=>{
    const read=fixture((name,b)=>{if(name!=='release-sqlite-coordinated-runtime.json')return b;const m=JSON.parse(b.toString());m[field]='invalid';return Buffer.from(JSON.stringify(m))})
    await expect(management.createManagementZip(read,profile)).rejects.toHaveProperty('code','corrupt')
  })
  it('refuses missing optional code or notices instead of falling back to default SQLite',async()=>{
    for(const name of ['release-sqlite-coordinated-runtime.mjs','release-sqlite-coordinated-NOTICES.txt'])await expect(management.createManagementZip(fixture((n,b)=>n===name?Buffer.alloc(0):b),profile)).rejects.toHaveProperty('code','corrupt')
  })
  const altered=[
    {name:'missing optional program',change:(f:Record<string,Uint8Array>)=>{delete f['jevable/dist/release-sqlite-coordinated-runtime.mjs']}},
    {name:'changed optional program',change:(f:Record<string,Uint8Array>)=>{f['jevable/dist/release-sqlite-coordinated-runtime.mjs']=Buffer.from('altered')}},
    {name:'missing profile marker',change:(f:Record<string,Uint8Array>)=>{const m=JSON.parse(Buffer.from(f['jevable/manifest.json']!).toString());delete m.rateCoordinator;f['jevable/manifest.json']=Buffer.from(JSON.stringify(m))}},
    {name:'unsupported profile marker',change:(f:Record<string,Uint8Array>)=>{const m=JSON.parse(Buffer.from(f['jevable/manifest.json']!).toString());m.rateCoordinator='redis';f['jevable/manifest.json']=Buffer.from(JSON.stringify(m))}},
    {name:'mixed schema generations',change:(f:Record<string,Uint8Array>)=>{const m=JSON.parse(Buffer.from(f['jevable/runtime-manifest.json']!).toString());m.schemaVersion=1;f['jevable/runtime-manifest.json']=Buffer.from(JSON.stringify(m))}},
    {name:'duplicate file records',change:(f:Record<string,Uint8Array>)=>{const m=JSON.parse(Buffer.from(f['jevable/manifest.json']!).toString());m.files[0]=m.files[1];f['jevable/manifest.json']=Buffer.from(JSON.stringify(m))}},
    {name:'foreign file',change:(f:Record<string,Uint8Array>)=>{f['jevable/extra-code.mjs']=Buffer.from('foreign')}},
    {name:'wrong workflow storage with rebound hashes',change:(f:Record<string,Uint8Array>)=>changeMetadata(f,m=>{m.storage='postgres'})},
    {name:'missing quota capability with rebound hashes',change:(f:Record<string,Uint8Array>)=>changeMetadata(f,m=>{delete m.rateCoordinator})},
  ]
  it.each(altered)('refuses $name during bounded offline inspection',async({name,change})=>{
    const result=await skill.createAgentSkillZip(fixture(),profile),bad=repack(result.bytes,change)
    await expect(inspectAgentSkillZip(bad,hash(bad))).rejects.toHaveProperty('code',name==='foreign file'?'limit':'corrupt')
  })
  it('does not let a schema-1 skill smuggle an undeclared optional runtime',async()=>{
    const result=await skill.createAgentSkillZip(fixture()),bad=repack(result.bytes,f=>{f['jevable/dist/release-sqlite-coordinated-runtime.mjs']=Buffer.from('undeclared')})
    await expect(inspectAgentSkillZip(bad,hash(bad))).rejects.toHaveProperty('code','corrupt')
  })
  it('rejects a different trusted archive checksum before archive inspection',async()=>{
    const result=await skill.createAgentSkillZip(fixture(),profile);await expect(inspectAgentSkillZip(result.bytes,'a'.repeat(64))).rejects.toHaveProperty('code','conflict')
  })
  it.each(['runtime','skill'])('CLI %s export selects the optional archive explicitly and refuses overwrite',async kind=>{
    const dir=await mkdtemp(join(tmpdir(),'jevable-profile-cli-')),path=join(dir,kind+'.zip'),result=kind==='runtime'?await management.createManagementZip(fixture(),profile):await skill.createAgentSkillZip(fixture(),profile)
    const selected=kind==='runtime'?vi.spyOn(management,'createManagementZip').mockResolvedValue(result as any):vi.spyOn(skill,'createAgentSkillZip').mockResolvedValue(result as any)
    let out='',err='';const capture={out:(s:string)=>{out+=s},err:(s:string)=>{err+=s}}
    expect(await main([kind,'export','--output',path,'--runtime-rate-coordinator','postgres'],capture)).toBe(0)
    expect(selected).toHaveBeenCalledWith(undefined,profile);expect(JSON.parse(out)).toMatchObject({schemaVersion:2,rateCoordinator:'postgres',state:'excluded',credentials:'excluded'})
    expect(await readFile(path)).toEqual(result.bytes);out='';expect(await main([kind,'export','--output',path,'--runtime-rate-coordinator','postgres'],capture)).toBe(1)
    expect(await readFile(path)).toEqual(result.bytes);expect(err).not.toContain('PRIVATE')
  })
  it.each(['runtime','skill'])('CLI %s rejects an unknown optional backend before any output',async kind=>{
    const dir=await mkdtemp(join(tmpdir(),'jevable-profile-bad-')),path=join(dir,'never-created.zip');let out=''
    expect(await main([kind,'export','--output',path,'--runtime-rate-coordinator','redis'],{out:s=>{out+=s},err(){}})).toBe(2);expect(out).toBe('')
    await expect(lstat(path)).rejects.toHaveProperty('code','ENOENT')
  })
})
