import { expect, it } from 'vitest'
import { PostgresProviderStore } from '../src/providers/postgres-store.ts'
import { PostgresJournal, JournalError, type JournalBatch, type JournalCollection } from '../src/storage/postgres.ts'

/** CAS/domain double, not real SQL durability or rollback qualification. */
class MemoryJournal {
  readonly signal=new AbortController().signal
  readonly rows=new Map<string,{key:string;version:string;deleted:boolean;value:unknown}>()
  readonly audit: {sequence:string;collection:JournalCollection;key:string;kind:string;data:unknown}[]=[]
  fail=false
  async get(_collection:JournalCollection,key:string) {return structuredClone(this.rows.get(key))}
  async count() {return this.rows.size}
  async commit(batch:JournalBatch) {
    if(this.fail) throw Error('synthetic precommit failure')
    for(const change of batch.changes) {
      if((this.rows.get(change.key)?.version ?? '0')!==change.expectedVersion) throw new JournalError('conflict')
      if(change.operation!=='put') throw Error('unexpected fixture operation')
    }
    for(const change of batch.changes) {
      if(change.operation!=='put') throw Error('unexpected fixture operation')
      this.rows.set(change.key,{key:change.key,version:String(Number(change.expectedVersion)+1),deleted:false,value:structuredClone(change.value)})
    }
    for(const event of batch.events ?? []) this.audit.push({...event,sequence:String(this.audit.length+1)})
  }
  async events() {return {cursor:String(this.audit.length),events:structuredClone(this.audit)}}
}
async function fixture() {
  const journal=new MemoryJournal(), store=new PostgresProviderStore(journal as unknown as PostgresJournal)
  await store.setCredential('fixture/key','PRIVATE_CLEAR_FIXTURE',0,'local:fixture')
  return {journal,store}
}
it('retains secret-free generation with audit and restores only through the next guarded write',async()=>{
  const {store,journal}=await fixture(), cleared=await store.clearCredential('fixture/key',1,'local:fixture')
  expect(cleared).toMatchObject({configured:false,generation:2})
  expect(await store.credential('fixture/key')).toBeUndefined(); expect(await store.credentialSnapshot('fixture/key')).toBeUndefined()
  expect(JSON.stringify(journal.rows.get('fixture/key'))).not.toContain('PRIVATE_CLEAR_FIXTURE')
  expect(await store.credentialStatus('fixture/key')).toEqual(cleared)
  const reopened=new PostgresProviderStore(journal as unknown as PostgresJournal)
  expect(await reopened.credentialStatus('fixture/key')).toEqual(cleared)
  expect((await reopened.auditEvents()).events.map(event=>event.kind)).toEqual(['credential-set','credential-cleared'])
  for(const generation of [0,1]) await expect(reopened.setCredential('fixture/key','stale-write',generation,'local:fixture')).rejects.toHaveProperty('code','conflict')
  await expect(reopened.clearCredential('fixture/key',2,'local:fixture')).rejects.toHaveProperty('code','conflict')
  expect(await reopened.setCredential('fixture/key','restored-key',2,'local:fixture')).toMatchObject({configured:true,generation:3})
})
it('serializes competing clears with only one state/audit settlement',async()=>{
  const {store,journal}=await fixture()
  const settled=await Promise.allSettled([store.clearCredential('fixture/key',1,'local:a'),store.clearCredential('fixture/key',1,'local:b')])
  expect(settled.map(value=>value.status)).toEqual(['fulfilled','rejected'])
  expect(journal.audit).toHaveLength(2); expect(await store.credentialStatus('fixture/key')).toMatchObject({configured:false,generation:2})
})
it('precommit failure retains the original value/generation and audit',async()=>{
  const {store,journal}=await fixture(), before=await store.credentialStatus('fixture/key')
  journal.fail=true
  await expect(store.clearCredential('fixture/key',1,'local:fixture')).rejects.toThrow('synthetic precommit failure')
  expect(await store.credentialStatus('fixture/key')).toEqual(before)
  expect(await store.credential('fixture/key')).toBe('PRIVATE_CLEAR_FIXTURE'); expect(journal.audit).toHaveLength(1)
})
it.each([0,-1,1.5,Number.MAX_SAFE_INTEGER,Infinity])('refuses invalid cleared generation %s before committing',async generation=>{
  const {store,journal}=await fixture()
  expect(()=>store.clearCredential('fixture/key',generation,'local:fixture')).toThrow('invalid-config')
  expect(journal.audit).toHaveLength(1)
})
it('refuses a secret-bearing tombstone and mismatched retained version',async()=>{
  const {store,journal}=await fixture(); await store.clearCredential('fixture/key',1,'local:fixture')
  const row=journal.rows.get('fixture/key')!, saved=structuredClone(row)
  row.value={...row.value as object,value:'covert-value'}
  await expect(store.credentialStatus('fixture/key')).rejects.toHaveProperty('code','corrupt-evidence')
  journal.rows.set('fixture/key',{...saved,version:'1'})
  await expect(store.credentialStatus('fixture/key')).rejects.toHaveProperty('code','corrupt-evidence')
})
