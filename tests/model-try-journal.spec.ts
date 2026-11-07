import { DatabaseSync } from 'node:sqlite'
import { createServer,type RequestListener } from 'node:http'
import { randomUUID } from 'node:crypto'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import { executeWorkflow,type ExecutionPersistence } from '../src/runtime/execution.ts'
import { compileLocalRun,initialCheckpoint } from '../src/runtime/run-evaluator.ts'
import { localRunSchema,type LocalRun } from '../src/runtime/run-types.ts'
import { DEFAULT_COMPILER_LIMITS as limits } from '../src/limits.ts'
import { ConfiguredModels } from '../src/providers/model-calls.ts'
import { ProviderStore } from '../src/providers/store.ts'
import type { ProviderPersistence } from '../src/providers/persistence.ts'
import { modelEvidenceVersion } from '../src/providers/evidence-transition.ts'
import type { ModelEvidence } from '../src/providers/records.ts'
import { traceRecords } from '../scripts/check-postgres-telemetry.mjs'
import { logRecords } from '../scripts/check-telemetry-package.mjs'

const cleanup:(()=>Promise<unknown>|void)[]=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.restoreAllMocks()})
const source=JSON.stringify({apiVersion:'jevable.ai/v1alpha1',kind:'Workflow',metadata:{id:'try-journal',name:'Private retry fixture'},
  spec:{inputSchema:{type:'string'},nodes:{start:{type:'trigger',config:{modes:['manual']}},model:{type:'llm',config:{
    provider:'fixture',model:'fixture-model',connection:{mode:'workspace',id:'fixture'},prompt:'${{ inputs }}',responseFormat:'text',historyScope:'none',
    generation:{maxTokens:30,stream:false},execution:{maxAttempts:2,timeoutSeconds:3}}},result:{type:'output',config:{value:'${{ nodes.model.output }}'}}},
    edges:[{from:'start',to:'model'},{from:'model',to:'result'}]}})
async function server(handler:RequestListener){
  const listener=createServer(handler)
  await new Promise<void>((yes,no)=>{listener.once('error',no);listener.listen(0,'127.0.0.1',yes)})
  cleanup.push(()=>new Promise<void>(yes=>{listener.close(()=>yes());listener.closeAllConnections()}))
  const address=listener.address();if(!address||typeof address==='string')throw Error('private fixture listener')
  return 'http://127.0.0.1:'+address.port
}
// Real shared driver/configured provider/private HTTP and OTLP, but simulated journal transactions.
// In-memory run persistence and SQLite model evidence are NOT real PostgreSQL qualification.
async function fixture(sampleRatio:number,failVersion?:number){
  const packets:{route:string;bytes:Buffer}[]=[],requests:unknown[]=[],failure=Error('PRIVATE_TRY_JOURNAL_FAILURE')
  const collector=await server(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk)
    packets.push({route:req.url!,bytes:Buffer.concat(chunks)});res.writeHead(200,{'content-type':'application/x-protobuf'});res.end()})
  const endpoint=await server(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));res.writeHead(requests.length===1?503:200,{'content-type':'application/json'})
    res.end(requests.length===1?'{}':JSON.stringify({choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'PRIVATE_TRY_RESULT'}}]}))})
  const telemetry=new RuntimeTelemetry({endpoint:collector+'/v1/traces',logsEndpoint:collector+'/v1/logs',authentication:{kind:'none'},
    sampleRatio,journalTransactions:true,intervalMs:60000,timeoutMs:1000,flushTimeoutMs:2000},()=>undefined,{storage:'postgres'})
  cleanup.push(()=>telemetry.close())
  const scopeSpy=vi.spyOn(telemetry,'withJournalSpan') // Pass through, do not replace methods or business work.
  async function journal<T>(kind:'read'|'write',work:()=>T|Promise<T>):Promise<T>{
    const observation=telemetry.observeJournalTransaction(kind)
    try{const value=await work();observation?.end('acknowledged');return value}
    catch(error){observation?.end('failed-before-commit');throw error}
  }
  const database=new DatabaseSync(':memory:');database.exec('CREATE TABLE model_calls(attempt_id TEXT PRIMARY KEY,record TEXT NOT NULL)')
  cleanup.push(()=>database.close());const durable=new ProviderStore(database,100_000),writes:ModelEvidence[]=[]
  const store:ProviderPersistence={connection:()=>journal('read',()=>({generation:1,updatedAt:new Date().toISOString(),connection:{
    id:'fixture',provider:'fixture',protocol:'openai-compatible',endpoint:endpoint+'/v1',allowedModels:['fixture-model'],authentication:{kind:'none'},
    tokenParameter:'max_tokens',maxResponseBytes:10000,maxRequestBytes:10000,maxStreamEvents:100,maxTimeoutSeconds:5}})),
    credential:()=>journal('read',()=>undefined),evidence:id=>journal('read',()=>durable.evidence(id)),
    saveEvidence:record=>journal('write',()=>{if(modelEvidenceVersion(record)===failVersion)throw failure;durable.saveEvidence(record);writes.push(structuredClone(record))})}
  const graph=compileLocalRun(source,limits),at=new Date().toISOString()
  let record:LocalRun={schemaVersion:1,id:randomUUID(),yaml:graph.source.yaml,revision:graph.source.revision,input:'PRIVATE_TRY_INPUT',
    createdAt:at,updatedAt:at,state:initialCheckpoint(graph),loopDeadlines:{}}
  const events:{kind:string;data:unknown}[]=[]
  const port:ExecutionPersistence={load:()=>journal('read',()=>structuredClone(record)),events:()=>journal('read',()=>structuredClone(events)),
    save:(next,kind,data)=>journal('write',()=>{record=localRunSchema.parse(next) as LocalRun;events.push({kind,data:structuredClone(data)})}),
    saveSegment:next=>journal('write',()=>{record=next;return next}),finishCancellation:next=>journal('write',()=>next)}
  const models=new ConfiguredModels(store)
  return{telemetry,scopeSpy,requests,writes,failure,durable,packets,
    run:()=>executeWorkflow({initial:structuredClone(record),graph,limits,maxTransitions:100,operation:'run',signal:new AbortController().signal,port,models,telemetry}),
    spans:()=>packets.filter(p=>p.route==='/v1/traces').flatMap(p=>traceRecords(p.bytes)),
    logs:()=>packets.filter(p=>p.route==='/v1/logs').flatMap(p=>logRecords(p.bytes))}
}
describe('model try journal ancestry in the shared execution driver',()=>{
  it.each([0,1])('scopes each actual provider retry intent/settlement to its live try at sampling %s',async sampleRatio=>{
    const f=await fixture(sampleRatio),result=await f.run();await f.telemetry.flush()
    expect(result.state).toMatchObject({status:'completed',output:'PRIVATE_TRY_RESULT'});expect(f.requests).toHaveLength(2)
    expect(f.writes.map(modelEvidenceVersion)).toEqual([1,2,3,4])
    const last=f.writes.at(-1);if(last?.schemaVersion!==2)throw Error('retry record')
    const contexts=last.tries.map(t=>t.trace!);expect(contexts).toHaveLength(2)
    for(const trace of contexts){expect(trace.traceFlags).toBe(sampleRatio)
      expect(f.scopeSpy.mock.calls.filter(([span])=>span?.spanContext().spanId===trace.spanId)).toHaveLength(2)}
    if(sampleRatio){const spans=f.spans(),tries=spans.filter(s=>s.name==='jevable.model.try');expect(tries).toHaveLength(2)
      for(const span of tries)expect(spans.filter(s=>s.name==='jevable.storage.journal.transaction'&&s.parent===span.spanId)).toHaveLength(2)
      const backoff=spans.find(s=>s.name==='jevable.model.backoff')!;expect(backoff).toBeDefined()
      expect(spans.filter(s=>s.name==='jevable.storage.journal.transaction'&&s.parent===backoff.spanId)).toHaveLength(0)
    }else{expect(f.spans()).toHaveLength(0);expect(f.logs().filter(l=>l.event==='jevable.model.try.ended')).toHaveLength(2)}
    for(const p of f.packets)expect(p.bytes.includes(Buffer.from('PRIVATE_'))).toBe(false)
  })
  it.each([1,2,3,4])('failed try write at version %s keeps exact failure and single dispatch/settlement history',async version=>{
    const f=await fixture(1,version);await expect(f.run()).rejects.toBe(f.failure);await f.telemetry.flush()
    expect(f.requests).toHaveLength(version===1?0:version===4?2:1)
    expect(f.writes.map(modelEvidenceVersion)).toEqual(Array.from({length:version-1},(_,i)=>i+1))
    const spans=f.spans(),tries=spans.filter(s=>s.name==='jevable.model.try').sort((a,b)=>Number(a.attributes['jevable.model.try.number'])-Number(b.attributes['jevable.model.try.number']))
    expect(tries).toHaveLength(version>=3?2:1)
    for(const[i,span]of tries.entries()){
      const journals=spans.filter(s=>s.name==='jevable.storage.journal.transaction'&&s.parent===span.spanId)
      expect(journals).toHaveLength(i===tries.length-1?(version%2?1:2):2)
      expect(journals.at(-1)?.attributes['jevable.storage.transaction.outcome']).toBe(i===tries.length-1?'failed-before-commit':'acknowledged')
    }
    expect(tries.at(-1)?.attributes['jevable.model.try.settled']).toBe(false)
  })
})
