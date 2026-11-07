import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime } from '../src/runtime/local.ts'
import { main } from '../src/cli.ts'
import { startRuntimeService, RuntimeClient } from '../src/http/index.ts'
import { credentialRecordSchema } from '../src/providers/records.ts'
import { runtimeOperationSchema } from '../src/http/operations.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function owner() {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-clear-'))
  const runtime = await LocalRuntime.open({dataDirectory:directory})
  cleanup.push(() => runtime.close())
  runtime.setCredential('fixture/key','PRIVATE_CLEAR_FIXTURE',0,'local:fixture')
  return {runtime,directory}
}
it('clears an active generation without resetting its CAS identity and preserves it across reopen',async () => {
  const {runtime,directory} = await owner()
  const cleared = runtime.clearCredential('fixture/key',1,'local:fixture')
  expect(cleared).toMatchObject({configured:false,generation:2})
  expect(JSON.stringify(cleared)).not.toContain('PRIVATE_CLEAR_FIXTURE')
  const database = new DatabaseSync(join(directory,'runtime.sqlite'),{readOnly:true})
  try {
    const row = database.prepare('SELECT record FROM provider_credentials WHERE ref=?').get('fixture/key') as {record:string}
    expect(JSON.parse(row.record)).toEqual({ref:'fixture/key',cleared:true,generation:2,updatedAt:cleared.updatedAt})
  } finally {database.close()}
  for (const generation of [0,1]) expect(() => runtime.setCredential('fixture/key','stale-write',generation,'local:fixture')).toThrow('conflict')
  expect(() => runtime.clearCredential('fixture/key',1,'local:fixture')).toThrow('conflict')
  expect(() => runtime.clearCredential('fixture/key',2,'local:fixture')).toThrow('conflict')
  await runtime.close()
  const reopened = await LocalRuntime.open({dataDirectory:directory}); cleanup.push(() => reopened.close())
  expect(reopened.credentialStatus('fixture/key')).toEqual(cleared)
  expect(reopened.providerAudit().map(event => event.kind)).toEqual(['credential-set','credential-cleared'])
  expect(JSON.stringify(reopened.providerAudit())).not.toContain('PRIVATE_CLEAR_FIXTURE')
  expect(reopened.setCredential('fixture/key','replacement-key',2,'local:fixture')).toMatchObject({configured:true,generation:3})
})
it('rolls back credential replacement when audit actor admission fails',async () => {
  const {runtime} = await owner(), before=runtime.credentialStatus('fixture/key')
  expect(() => runtime.clearCredential('fixture/key',1,' ')).toThrow('invalid-config')
  expect(runtime.credentialStatus('fixture/key')).toEqual(before)
  expect(runtime.providerAudit()).toHaveLength(1)
})
it.each([0,-1,1.5,Number.MAX_SAFE_INTEGER,Infinity])('rejects invalid next generation %s without mutation',async generation => {
  const {runtime} = await owner()
  expect(() => runtime.clearCredential('fixture/key',generation,'local:fixture')).toThrow('invalid-config')
  expect(runtime.credentialStatus('fixture/key')).toMatchObject({configured:true,generation:1})
})
it('refuses an absent or wrong reference and does not allocate a tombstone',async () => {
  const {runtime} = await owner()
  expect(() => runtime.clearCredential('fixture/absent',1,'local:fixture')).toThrow('conflict')
  expect(runtime.credentialStatus('fixture/absent')).toEqual({ref:'fixture/absent',configured:false,generation:0})
  expect(() => runtime.clearCredential('../outside',1,'local:fixture')).toThrow('invalid-config')
  expect(runtime.providerAudit()).toHaveLength(1)
})
it('does not clear configuration while admitted readiness work is pending',async () => {
  const gate=Promise.withResolvers<void>(), entered=Promise.withResolvers<void>()
  const directory=await mkdtemp(join(tmpdir(),'jevable-clear-busy-'))
  const runtime=await LocalRuntime.open({dataDirectory:directory,models:{admit:async()=>{entered.resolve(); await gate.promise},verify:async()=>{},execute:async()=>({output:'not-used',usage:{tries:1}})}})
  cleanup.push(() => runtime.close()); runtime.setCredential('fixture/key','PRIVATE_CLEAR_FIXTURE',0,'local:fixture')
  const pending=runtime.check(await readFile(new URL('../examples/support.yaml',import.meta.url),'utf8'))
  await entered.promise
  try {expect(() => runtime.clearCredential('fixture/key',1,'local:fixture')).toThrow('busy')}
  finally {gate.resolve(); await pending}
  expect(runtime.credentialStatus('fixture/key')).toMatchObject({configured:true,generation:1})
})
it('CLI clearing is explicit, secret-free, guarded and followed by ordinary status observation',async () => {
  const directory=await mkdtemp(join(tmpdir(),'jevable-clear-cli-')), data=join(directory,'state'), secret=join(directory,'key')
  await writeFile(secret,'PRIVATE_CLEAR_FIXTURE\n',{mode:0o600})
  let output='', error=''; const io={out:(text:string)=>{output=text},err:(text:string)=>{error=text}}
  expect(await main(['credentials','set','fixture/key','--expected-generation','0','--file',secret,'--data-dir',data],io)).toBe(0)
  expect(await main(['credentials','clear','fixture/key','--expected-generation','1','--data-dir',data],io)).toBe(0)
  expect(JSON.parse(output)).toMatchObject({configured:false,generation:2})
  expect(output+error).not.toContain('PRIVATE_CLEAR_FIXTURE')
  expect(await main(['credentials','clear','fixture/key','--expected-generation','1','--data-dir',data],io)).toBe(1)
  expect(await main(['credentials','status','fixture/key','--data-dir',data],io)).toBe(0)
  expect(JSON.parse(output)).toMatchObject({configured:false,generation:2})
  expect(await readFile(secret,'utf8')).toBe('PRIVATE_CLEAR_FIXTURE\n')
})
it.each([[],['--expected-generation','0'],['--expected-generation','1','--file','/must-not-read'],['--expected-generation','1','--stdin']].map(flags=>({flags})))
  ('refuses malformed CLI clear options before owner creation $flags',async ({flags}) => {
    const directory=await mkdtemp(join(tmpdir(),'jevable-clear-admission-')), data=join(directory,'not-created')
    expect(await main(['credentials','clear','fixture/key',...flags,'--data-dir',data],{out:()=>{},err:()=>{}})).toBe(2)
    await expect(lstat(data)).rejects.toHaveProperty('code','ENOENT')
  })
it('owner HTTP clearing fixes actor on the host and refuses body authority overrides',async () => {
  const dataDirectory=await mkdtemp(join(tmpdir(),'jevable-clear-http-')), token='f'.repeat(64)
  const service=await startRuntimeService({runtime:{dataDirectory},token,actor:'local:clear-host'})
  cleanup.push(async()=>{await service.close(); await service.closed})
  const client=new RuntimeClient(service.url,token)
  await client.operation({operation:'credentials.set',ref:'fixture/key',value:'PRIVATE_CLEAR_FIXTURE',expectedGeneration:0})
  expect(runtimeOperationSchema.safeParse({operation:'credentials.clear',ref:'fixture/key',expectedGeneration:1,actor:'caller:forged'}).success).toBe(false)
  const result=await client.operation({operation:'credentials.clear',ref:'fixture/key',expectedGeneration:1})
  expect(JSON.stringify(result)).not.toContain('PRIVATE_CLEAR_FIXTURE')
  expect(JSON.stringify(await client.operation({operation:'providers.audit'}))).toContain('local:clear-host')
  expect(JSON.stringify(await client.operation({operation:'credentials.status',ref:'fixture/key'}))).toContain('"configured":false')
})
it('refuses secret-bearing or malformed cleared durable records',()=>{
  const valid={ref:'fixture/key',generation:2,updatedAt:new Date().toISOString(),cleared:true}
  expect(credentialRecordSchema.safeParse(valid).success).toBe(true)
  for(const value of [{...valid,value:'PRIVATE_CLEAR_FIXTURE'},{...valid,cleared:false},{...valid,generation:0}])
    expect(credentialRecordSchema.safeParse(value).success).toBe(false)
})
