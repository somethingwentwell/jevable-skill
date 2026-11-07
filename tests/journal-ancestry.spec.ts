import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpanStatusCode, type Span } from '@opentelemetry/api'
import { RuntimeTelemetry } from '../src/telemetry/traces.ts'
import type { TelemetryConfig } from '../src/telemetry/config.ts'
import { PostgresJournal, JournalError, parsePostgresConfiguration } from '../src/storage/postgres.ts'
import { PostgresRuntime } from '../src/runtime/postgres.ts'
import { PostgresRunStore } from '../src/runtime/postgres-store.ts'
import { validateRunTransition } from '../src/runtime/run-transition.ts'
import { compileLocalRun } from '../src/runtime/run-evaluator.ts'
import { localRunSchema, executionCheckpointHash, type LocalRun } from '../src/runtime/run-types.ts'
import { WorkflowRuntimeError } from '../src/runtime/errors.ts'
import { DEFAULT_COMPILER_LIMITS as limits } from '../src/limits.ts'
import type { ModelCalls } from '../src/runtime/model-port.ts'
import { traceRecords } from '../scripts/check-postgres-telemetry.mjs'
import { logRecords } from '../scripts/check-telemetry-package.mjs'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const echo = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const approval = await readFile(new URL('../examples/approval.yaml', import.meta.url), 'utf8')
const modelSource = JSON.stringify({ apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: 'journal-model', name: 'Private fixture' },
  spec: { inputSchema: { type: 'string' }, nodes: { start: { type: 'trigger', config: { modes: ['manual'] } },
    model: { type: 'llm', config: { provider: 'fixture', model: 'fixture', connection: { mode: 'workspace', id: 'fixture' },
      prompt: '${{ inputs }}', responseFormat: 'text', historyScope: 'none', generation: { maxTokens: 30, stream: false }, execution: { maxAttempts: 1, timeoutSeconds: 2 } } },
    result: { type: 'output', config: { value: '${{ nodes.model.output }}' } } }, edges: [{ from: 'start', to: 'model' }, { from: 'model', to: 'result' }] } })
const database = { host: '127.0.0.1', port: 5432, database: 'fixture', user: 'fixture', password: 'PRIVATE_PASSWORD',
  namespace: 'PRIVATE_NAMESPACE', initialize: false, tls: { mode: 'loopback-test' as const } }
const parent = '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01'
function held() { let release!: () => void; const promise = new Promise<void>(yes => { release = yes }); return { promise, release } }
async function receiver() {
  const packets: { route: string; bytes: Buffer }[] = []
  const server = createServer(async (request,response) => {
    const chunks: Buffer[]=[];for await(const chunk of request)chunks.push(chunk)
    packets.push({route:request.url!,bytes:Buffer.concat(chunks)});response.writeHead(200,{'content-type':'application/x-protobuf'});response.end()
  })
  await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes)})
  cleanup.push(()=>new Promise<void>(yes=>{server.close(()=>yes());server.closeAllConnections()}))
  const address=server.address();if(!address||typeof address==='string')throw Error('listener')
  const config:TelemetryConfig={endpoint:`http://127.0.0.1:${address.port}/v1/traces`,logsEndpoint:`http://127.0.0.1:${address.port}/v1/logs`,
    authentication:{kind:'none'},intervalMs:60000,timeoutMs:1000,flushTimeoutMs:2000,journalTransactions:true,baggageKeys:['request.class']}
  const spans=()=>packets.filter(p=>p.route==='/v1/traces').flatMap(p=>traceRecords(p.bytes))
  const logs=()=>packets.filter(p=>p.route==='/v1/logs').flatMap(p=>logRecords(p.bytes))
  return {config,packets,spans,logs}
}
function telemetry(config:TelemetryConfig) {const owner=new RuntimeTelemetry(config,()=>undefined,{storage:'postgres'});cleanup.push(()=>owner.close());return owner}

// Actual SDK/queue/execution/transition guards with in-memory run persistence and a SQL-client double.
// This is NOT actual PostgreSQL persistence, journal receipts, provider or deployment qualification.
async function runtimeFixture(options:Partial<TelemetryConfig>={}) {
  const wire=await receiver(), client=new EventEmitter() as EventEmitter & {query:ReturnType<typeof vi.fn>;end:ReturnType<typeof vi.fn>}
  const {password:_password,...policy}=parsePostgresConfiguration(database)
  const journal=new (PostgresJournal as any)(client,policy) as PostgresJournal
  Object.assign(journal,{state:'open',epoch:'1'})
  client.query=vi.fn(async(sql:string)=>({rows:sql.startsWith('SELECT owner_id')?[{owner_id:journal.ownerId,epoch:'1'}]:sql.startsWith('SELECT count(*)')?[{count:'0'}]:[]}))
  client.end=vi.fn(async()=>{});cleanup.push(()=>journal.close())
  const enqueue=<T>(work:()=>Promise<T>,kind:'read'|'write'='read'):Promise<T>=>(journal as any).enqueue(work,kind)
  const rows=new Map<string,{record:LocalRun;version:string;events:any[]}>()
  let failWrite:((kind:string)=>void)|undefined, failRead:(()=>void)|undefined
  let acknowledge:((kind:string)=>Promise<void>)|undefined
  vi.spyOn(PostgresJournal,'open').mockResolvedValue(journal)
  vi.spyOn(PostgresRunStore.prototype,'get').mockImplementation(async id=>{
    const row=await enqueue(async()=>{failRead?.();const row=rows.get(id);return row?structuredClone({record:row.record,version:row.version}):undefined})
    // Domain not-found belongs outside the acknowledged journal read, as in the real adapter.
    if(!row)throw new WorkflowRuntimeError('not-found');return row
  })
  vi.spyOn(PostgresRunStore.prototype,'events').mockImplementation(id=>enqueue(async()=>structuredClone(rows.get(id)!.events)))
  vi.spyOn(PostgresRunStore.prototype,'save').mockImplementation(command=>enqueue(async()=>{
    failWrite?.(command.kind)
    const record=localRunSchema.parse(command.record) as LocalRun, previous=rows.get(record.id)
    expect(previous?.version??'0').toBe(command.expectedVersion)
    const graph=compileLocalRun(record.yaml,limits,record.triggerMode)
    validateRunTransition(previous?.record,record,command.kind,command.data,graph,limits)
    const version=String(BigInt(command.expectedVersion)+1n), events=[...previous?.events??[],{sequence:version,version,kind:command.kind,at:record.updatedAt,data:structuredClone(command.data)}]
    rows.set(record.id,{record:structuredClone(record),version,events})
    await acknowledge?.(command.kind)
    return undefined as any
  },'write'))
  const runtime=await PostgresRuntime.open({database,telemetry:{...wire.config,...options}});cleanup.push(()=>runtime.close())
  const models:ModelCalls={admit(){},async verify(){await enqueue(async()=>undefined)},
    execute:vi.fn(async()=>{await enqueue(async()=>undefined,'write');await enqueue(async()=>undefined);return {output:'PRIVATE_MODEL_OUTPUT',usage:{tries:1}}}),
    recover:vi.fn(async()=>({output:'PRIVATE_MODEL_OUTPUT',usage:{tries:1}}))}
  Object.assign(runtime,{models})
  return {wire,journal,client,runtime,rows,models,enqueue,setFailure(write:typeof failWrite,read?:typeof failRead){failWrite=write;failRead=read},
    setAcknowledgement(work:typeof acknowledge){acknowledge=work}}
}
const journalSpans=(wire:Awaited<ReturnType<typeof receiver>>)=>wire.spans().filter(s=>s.name==='jevable.storage.journal.transaction')

describe('owned ephemeral journal ancestry',()=>{
  it.each([0,1])('an ended owned span cannot parent new journal work at sampling %s',async sampleRatio=>{
    const wire=await receiver(),owner=telemetry({...wire.config,sampleRatio}),span=owner.start('jevable.node',{})
    // Core node settlement ends the Span directly, not necessarily through RuntimeTelemetry.end.
    span.end()
    owner.withJournalSpan(span,()=>owner.observeJournalTransaction('read')!.end('acknowledged'))
    await owner.flush()
    const logs=wire.logs().filter(l=>l.event==='jevable.storage.journal.transaction.ended')
    expect(logs).toHaveLength(1);expect(logs[0]!.traceId).not.toBe(span.spanContext().traceId)
    if(sampleRatio)expect(journalSpans(wire)[0]!.parent).toBeUndefined()
  })
  it('delayed work drops an ended scope and keeps the explicit incoming request parent',async()=>{
    const wire=await receiver(),owner=telemetry(wire.config),gate=held()
    await owner.withParent(parent,async()=>{
      const span=owner.start('jevable.model',{})
      const pending=owner.withJournalSpan(span,async()=>{await gate.promise;owner.observeJournalTransaction('write')!.end('acknowledged')})
      owner.end(span,'completed');gate.release();await pending
      expect(owner.parent()?.spanId).toBe('2'.repeat(16))
    })
    await owner.flush();expect(journalSpans(wire)[0]!.parent).toBe('2'.repeat(16))
  })
  it.each([0,1])('an ended nested node scope falls back to its still-live segment, then drops that ended segment too at sampling %s',async sampleRatio=>{
    const wire=await receiver(),owner=telemetry({...wire.config,sampleRatio}),segment=owner.start('jevable.run',{}),node=owner.start('jevable.node',{},segment.spanContext())
    await owner.withJournalSpan(segment,()=>owner.withJournalSpan(node,async()=>{
      node.end();await Promise.resolve()
      owner.withJournalFallback(segment,()=>owner.observeJournalTransaction('read')!.end('acknowledged'))
      segment.end();owner.observeJournalTransaction('write')!.end('acknowledged')
    }))
    await owner.flush();const spans=journalSpans(wire),logs=wire.logs().filter(l=>l.event==='jevable.storage.journal.transaction.ended')
    expect(logs).toHaveLength(2);expect(logs[0]!.traceId).toBe(segment.spanContext().traceId);expect(logs[1]!.traceId).not.toBe(segment.spanContext().traceId)
    if(sampleRatio){expect(spans[0]!.parent).toBe(segment.spanContext().spanId);expect(spans[1]!.parent).toBeUndefined()}
    else expect(spans).toHaveLength(0)
  })
  it('a transaction started under a live span retains that original parent if the parent ends before acknowledgement',async()=>{
    const wire=await receiver(),owner=telemetry(wire.config),span=owner.start('jevable.model',{})
    const transaction=owner.withJournalSpan(span,()=>owner.observeJournalTransaction('write')!)
    span.end();transaction.end('acknowledged');await owner.flush()
    expect(journalSpans(wire)[0]!.parent).toBe(span.spanContext().spanId)
  })
  it('a new live fallback replaces a dead-only scope without modifying the incoming request',async()=>{
    const wire=await receiver(),owner=telemetry(wire.config),dead=owner.start('jevable.node',{}),live=owner.start('jevable.run',{})
    owner.withParent(parent,()=>owner.withJournalSpan(dead,()=>{
      dead.end();owner.withJournalFallback(live,()=>owner.observeJournalTransaction('write')!.end('acknowledged'))
      expect(owner.parent()?.spanId).toBe('2'.repeat(16))
      owner.observeJournalTransaction('read')!.end('acknowledged')
    }))
    live.end();await owner.flush();const spans=journalSpans(wire)
    expect(spans[0]!.parent).toBe(live.spanContext().spanId);expect(spans[1]!.parent).toBe('2'.repeat(16))
  })
  it.each([0,1])('queued SQL work selects a live parent when execution begins, not when enqueued at sampling %s',async sampleRatio=>{
    const f=await runtimeFixture({sampleRatio}),gate=held(),entered=held()
    const blocker=f.enqueue(async()=>{entered.release();await gate.promise})
    await entered.promise
    const owner=(f.runtime as any).telemetry as RuntimeTelemetry,span=owner.start('jevable.model',{})
    const queued=owner.withJournalSpan(span,()=>f.enqueue(async()=>undefined,'write'))
    span.end();gate.release();await Promise.all([blocker,queued]);await f.runtime.telemetryFlush()
    const logs=f.wire.logs().filter(l=>l.event==='jevable.storage.journal.transaction.ended'&&l.attributes['jevable.storage.transaction.kind']==='write')
    expect(logs).toHaveLength(1);expect(logs[0]!.traceId).not.toBe(span.spanContext().traceId)
    if(sampleRatio)expect(journalSpans(f.wire).find(s=>s.attributes['jevable.storage.transaction.kind']==='write')!.parent).toBeUndefined()
  })
  it('ending one concurrent delayed scope does not invalidate the other live scope',async()=>{
    const wire=await receiver(),owner=telemetry(wire.config),gate=held(),first=owner.start('jevable.run',{}),second=owner.start('jevable.run',{})
    const a=owner.withJournalSpan(first,async()=>{await gate.promise;owner.observeJournalTransaction('read')!.end('acknowledged')})
    const b=owner.withJournalSpan(second,async()=>{await gate.promise;owner.observeJournalTransaction('write')!.end('acknowledged')})
    first.end();gate.release();await Promise.all([a,b]);second.end();await owner.flush()
    const spans=journalSpans(wire)
    expect(spans.find(s=>s.attributes['jevable.storage.transaction.kind']==='read')!.parent).toBeUndefined()
    expect(spans.find(s=>s.attributes['jevable.storage.transaction.kind']==='write')!.parent).toBe(second.spanContext().spanId)
  })
  it('a diagnostic inner end fault invalidates ancestry without retrying the end or journal work',async()=>{
    const wire=await receiver(),owner=telemetry(wire.config),span=owner.start('jevable.node',{}),error=Error('PRIVATE_END')
    const inner=(span as any).inner as Span,original=inner.end.bind(inner),end=vi.spyOn(inner,'end').mockImplementation(()=>{original();throw error})
    expect(()=>span.end()).toThrow(error);span.end();expect(end).toHaveBeenCalledOnce()
    const work=vi.fn(()=>owner.observeJournalTransaction('read')!.end('acknowledged'))
    owner.withJournalSpan(span,work);expect(work).toHaveBeenCalledOnce();await owner.flush()
    expect(journalSpans(wire)[0]!.parent).toBeUndefined()
  })
  it('a live inner node remains the parent when its outer segment ends first',async()=>{
    const wire=await receiver(),owner=telemetry(wire.config),segment=owner.start('jevable.run',{}),node=owner.start('jevable.node',{},segment.spanContext())
    owner.withJournalSpan(segment,()=>owner.withJournalSpan(node,()=>{
      segment.end();owner.observeJournalTransaction('read')!.end('acknowledged')
      node.end();owner.observeJournalTransaction('write')!.end('acknowledged')
    }))
    await owner.flush();const spans=journalSpans(wire)
    expect(spans[0]!.parent).toBe(node.spanContext().spanId);expect(spans[1]!.parent).toBeUndefined()
  })
  it('the owned wrapper forwards span attributes/status and emits execution signals once across repeated end',async()=>{
    const wire=await receiver(),owner=telemetry(wire.config),span=owner.start('jevable.run',{'jevable.run.id':randomUUID()})
    expect(span.setAttribute('jevable.outcome','completed')).toBe(span)
    expect(span.setAttributes({'jevable.runtime.mode':'local'})).toBe(span)
    expect(span.setStatus({code:SpanStatusCode.OK})).toBe(span)
    span.end();span.end();owner.end(span,'completed');await owner.flush()
    const emitted=wire.spans().filter(s=>s.name==='jevable.run'),logs=wire.logs().filter(l=>l.event==='jevable.execution.segment.ended')
    expect(emitted).toHaveLength(1);expect(logs).toHaveLength(1)
    expect(emitted[0]!.attributes['jevable.outcome']).toBe('completed')
    expect(emitted[0]!.attributes['jevable.runtime.mode']).toBe('local')
    expect(logs[0]!.spanId).toBe(span.spanContext().spanId)
  })
  it('scopes only spans created by this owner, preserving exact sync/async returns and original errors',async()=>{
    const wire=await receiver(), owner=telemetry(wire.config), span=owner.start('jevable.run',{}), value={}, error=Error('PRIVATE_WORK')
    expect(owner.withJournalSpan(span,()=>value)).toBe(value)
    const promise=Promise.resolve(value);expect(owner.withJournalSpan(span,()=>promise)).toBe(promise)
    const work=vi.fn(()=>{throw error});expect(()=>owner.withJournalSpan(span,work)).toThrow(error);expect(work).toHaveBeenCalledOnce()
    const foreign=vi.fn(()=>{throw Error('PRIVATE_FOREIGN_CONTEXT')})
    expect(owner.withJournalSpan({spanContext:foreign} as unknown as Span,()=>value)).toBe(value);expect(foreign).not.toHaveBeenCalled()
    const foreignOwner=telemetry(wire.config), foreignSpan=foreignOwner.start('jevable.node',{})
    owner.withJournalSpan(foreignSpan,()=>owner.observeJournalTransaction('read')!.end('acknowledged'))
    owner.end(span,'completed');foreignOwner.end(foreignSpan,'completed');await owner.flush()
    expect(journalSpans(wire)[0]!.parent).toBeUndefined()
  })
  it('keeps request parents/baggage unchanged and restores nested scopes after awaited failures',async()=>{
    const wire=await receiver(), owner=telemetry(wire.config), error=Error('PRIVATE_FAILURE')
    await owner.withTraceContext({traceparent:parent,baggage:'request.class=PRIVATE_BAGGAGE'},async()=>{
      const segment=owner.start('jevable.run',{}), node=owner.start('jevable.node',{},segment.spanContext())
      await owner.withJournalSpan(segment,async()=>{
        expect(owner.parent()?.spanId).toBe('2'.repeat(16));expect(owner.baggage()).toBe('request.class=PRIVATE_BAGGAGE')
        await expect(owner.withJournalSpan(node,async()=>{await Promise.resolve();owner.observeJournalTransaction('write')!.end('acknowledged');throw error})).rejects.toBe(error)
        owner.withJournalFallback(node,()=>owner.observeJournalTransaction('read')!.end('acknowledged'))
      })
      owner.observeJournalTransaction('read')!.end('acknowledged');owner.end(node,'completed');owner.end(segment,'completed')
    })
    await owner.flush();const spans=journalSpans(wire), core=wire.spans()
    expect(spans[0]!.parent).toBe(core.find(s=>s.name==='jevable.node')!.spanId)
    expect(spans[1]!.parent).toBe(core.find(s=>s.name==='jevable.run')!.spanId);expect(spans[2]!.parent).toBe('2'.repeat(16))
    expect(owner.parent()).toBeUndefined();expect(owner.baggage()).toBeUndefined()
  })
  it.each([false,true])('context read faults cannot rerun work or replace its error (enabled=%s)',async enabled=>{
    const wire=await receiver(),owner=telemetry({...wire.config,journalTransactions:enabled}),span=owner.start('jevable.run',{})
    const context=span.spanContext.bind(span), fault=vi.spyOn(span,'spanContext').mockImplementation(()=>{throw Error('PRIVATE_CONTEXT')})
    const value={},work=vi.fn(()=>value),error=Error('PRIVATE_OPERATION')
    expect(owner.withJournalSpan(span,work)).toBe(value);expect(work).toHaveBeenCalledOnce()
    expect(()=>owner.withJournalSpan(span,()=>{throw error})).toThrow(error)
    expect(fault).toHaveBeenCalledTimes(enabled?2:0);fault.mockImplementation(context);owner.end(span,'completed')
  })
  it('concurrent nested scopes on one telemetry owner keep independent segment/model parents',async()=>{
    const wire=await receiver(),owner=telemetry(wire.config),gate=held(),first=owner.start('jevable.run',{}),second=owner.start('jevable.run',{})
    const a=owner.withJournalSpan(first,async()=>{await gate.promise;owner.observeJournalTransaction('read')!.end('acknowledged')})
    owner.withJournalSpan(second,()=>owner.observeJournalTransaction('write')!.end('acknowledged'));gate.release();await a
    owner.end(first,'completed');owner.end(second,'completed');await owner.flush()
    expect(journalSpans(wire).find(s=>s.attributes['jevable.storage.transaction.kind']==='read')).toMatchObject({parent:first.spanContext().spanId,traceId:first.spanContext().traceId})
    expect(journalSpans(wire).find(s=>s.attributes['jevable.storage.transaction.kind']==='write')).toMatchObject({parent:second.spanContext().spanId,traceId:second.spanContext().traceId})
  })
  it.each([0,1])('direct SDK execution links journal work to actual segment/node/model contexts at sampling %s',async sampleRatio=>{
    const f=await runtimeFixture({sampleRatio}), run=await f.runtime.run(modelSource,'PRIVATE_INPUT');await f.runtime.telemetryFlush()
    expect(run.state).toMatchObject({status:'completed',output:'PRIVATE_MODEL_OUTPUT'});expect(f.models.execute).toHaveBeenCalledOnce()
    const journals=journalSpans(f.wire), logs=f.wire.logs(), root=run.traceSegments![0]!.trace
    const nodeIds=run.state.steps.map(step=>step.inspection!.trace!.spanId), modelContexts=logs.filter(log=>log.event==='jevable.model.call.ended')
    expect(modelContexts).toHaveLength(1);expect(modelContexts[0]!.traceId).toBe(root.traceId)
    const journalLogs=logs.filter(log=>log.event==='jevable.storage.journal.transaction.ended'&&log.traceId===root.traceId)
    expect(journalLogs.length).toBeGreaterThanOrEqual(10)
    if(sampleRatio){
      const descendants=journals.filter(s=>s.traceId===root.traceId)
      const core=f.wire.spans().filter(s=>s.traceId===root.traceId&&s.name!=='jevable.storage.journal.transaction')
      expect(core.find(s=>s.name==='jevable.run')!.parent).toBeUndefined()
      expect(descendants.some(s=>s.parent===root.spanId)).toBe(true)
      for(const nodeId of nodeIds)expect(descendants.some(s=>s.parent===nodeId)).toBe(true)
      const model=core.find(s=>s.name==='jevable.model')!;expect(descendants.filter(s=>s.parent===model.spanId)).toHaveLength(2)
      expect(descendants.every(s=>core.some(parent=>parent.spanId===s.parent))).toBe(true)
      for(const journal of descendants)expect(journalLogs.some(log=>log.spanId===journal.spanId)).toBe(true)
    }else expect(f.wire.spans()).toHaveLength(0)
    for(const packet of f.wire.packets)expect(packet.bytes.includes(Buffer.from('PRIVATE_'))).toBe(false)
    expect(run.traceSegments![0]!.parent).toBeUndefined()
  })
  it('retains the explicit incoming request as segment parent, not the internal journal context',async()=>{
    const f=await runtimeFixture(),run=await f.runtime.withTraceParent(parent,()=>f.runtime.run(echo,'PRIVATE_INPUT'))
    await f.runtime.telemetryFlush();expect(run.traceSegments![0]!.parent).toMatchObject({traceId:'1'.repeat(32),spanId:'2'.repeat(16)})
    const segment=f.wire.spans().find(s=>s.name==='jevable.run')!;expect(segment.parent).toBe('2'.repeat(16))
    expect(journalSpans(f.wire).some(s=>s.parent===segment.spanId)).toBe(true)
    expect(run.traceSegments).toHaveLength(1)
  })
  it('does not leak a completed node scope into successor setup, read-only retries or later health calls',async()=>{
    const f=await runtimeFixture(),id=randomUUID(),run=await f.runtime.run(echo,'PRIVATE_INPUT',{id})
    await f.runtime.telemetryFlush();const before=f.wire.spans().length, events=structuredClone(f.rows.get(id)!.events)
    expect((await f.runtime.run(echo,'PRIVATE_INPUT',{id})).state.status).toBe('completed');await f.runtime.health();await f.runtime.telemetryFlush()
    expect(f.rows.get(id)!.events).toEqual(events)
    const newSpans=f.wire.spans().slice(before);expect(newSpans.every(s=>s.name==='jevable.storage.journal.transaction'&&s.parent===undefined)).toBe(true)
    const root=run.traceSegments![0]!.trace;expect(journalSpans(f.wire).filter(s=>s.traceId===root.traceId&&s.parent===root.spanId).length).toBeGreaterThan(2)
  })
  it('approval persistence uses the new approval segment; continued nodes never inherit the old wait',async()=>{
    const f=await runtimeFixture(),waiting=await f.runtime.run(approval,{message:'PRIVATE_REVIEW'})
    if(waiting.state.status!=='waiting')throw Error('expected wait')
    const result=await f.runtime.decide(waiting.id,waiting.state.attempt.id,'approve','local:test');await f.runtime.telemetryFlush()
    expect(result.state).toMatchObject({status:'completed',output:'approve'});expect(result.traceSegments).toHaveLength(2)
    const segment=result.traceSegments!.at(-1)!.trace, journals=journalSpans(f.wire).filter(s=>s.traceId===segment.traceId)
    expect(journals.filter(s=>s.parent===segment.spanId).length).toBeGreaterThanOrEqual(2)
    expect(f.wire.spans().find(s=>s.spanId===segment.spanId)!.name).toBe('jevable.approval')
    expect(result.traceSegments!.at(-1)!.previous).toEqual(waiting.traceSegments![0]!.trace)
  })
  it('cancellation settlement overrides outer execution scope with its own live cancel segment',async()=>{
    const f=await runtimeFixture(),paused=await f.runtime.run(echo,'PRIVATE_INPUT',{paused:true})
    const result=await f.runtime.cancel(paused.id,randomUUID(),'local:test');await f.runtime.telemetryFlush()
    expect(result.state.status).toBe('cancelled');const segment=result.traceSegments![0]!.trace
    const journals=journalSpans(f.wire).filter(s=>s.traceId===segment.traceId)
    expect(journals.filter(s=>s.parent===segment.spanId)).toHaveLength(2)
    expect(f.wire.spans().find(s=>s.spanId===segment.spanId)!.name).toBe('jevable.cancel')
    expect(result.traceSegments![0]!.parent).toBeUndefined()
  })
  it('read-only response recovery scopes its settlement to a new resume segment without redispatch',async()=>{
    const f=await runtimeFixture(),original=new JournalError('commit-uncertain');let refuse=true
    f.setFailure(kind=>{if(refuse&&kind==='node-result'&&[...f.rows.values()].some(row=>row.record.state.status==='executing'&&row.record.state.next==='model'))throw original})
    const id=randomUUID();await expect(f.runtime.run(modelSource,'PRIVATE_INPUT',{id})).rejects.toBe(original)
    refuse=false;const before=f.rows.get(id)!.record
    const result=await f.runtime.advance(id,{requestId:randomUUID(),mode:'recover',expectedCheckpointSha256:executionCheckpointHash(before)},'local:test')
    await f.runtime.telemetryFlush();expect(result.state).toMatchObject({status:'paused',next:'result'});expect(f.models.execute).toHaveBeenCalledOnce();expect(f.models.recover).toHaveBeenCalledOnce()
    const segment=result.traceSegments!.at(-1)!.trace,journals=journalSpans(f.wire).filter(s=>s.traceId===segment.traceId)
    expect(journals.filter(s=>s.parent===segment.spanId).length).toBeGreaterThanOrEqual(2)
    expect(f.wire.spans().find(s=>s.spanId===segment.spanId)!.name).toBe('jevable.resume')
  })
  it('preserves an uncertain checkpoint error when a subsequent owner read fails, without model redispatch',async()=>{
    const f=await runtimeFixture(),original=new JournalError('commit-uncertain');let lost=false
    f.setFailure(kind=>{if(kind==='node-result'&&[...f.rows.values()].some(row=>row.record.state.status==='executing'&&row.record.state.next==='model')){lost=true;throw original}},()=>{if(lost)throw new JournalError('ownership-lost')})
    await expect(f.runtime.run(modelSource,'PRIVATE_INPUT')).rejects.toBe(original);expect(f.models.execute).toHaveBeenCalledOnce()
    // An actually lost owner refuses public flush; its owned close still drains diagnostics without new SQL.
    await f.runtime.close();const core=f.wire.spans().filter(s=>s.name!=='jevable.storage.journal.transaction')
    expect(core.some(s=>s.name==='jevable.model')).toBe(true)
    expect(journalSpans(f.wire).some(s=>s.attributes['jevable.storage.transaction.outcome']==='failed-before-commit')).toBe(true)
  })
  it('two overlapping model runs on one owner never cross their segment ancestry',async()=>{
    const f=await runtimeFixture(),ready=held(),release=held();let entered=0
    f.models.execute=vi.fn(async()=>{await f.enqueue(async()=>undefined);if(++entered===2)ready.release();await release.promise;await f.enqueue(async()=>undefined,'write');return {output:'PRIVATE_MODEL_OUTPUT',usage:{tries:1}}})
    const first=f.runtime.run(modelSource,'PRIVATE_FIRST'),second=f.runtime.run(modelSource,'PRIVATE_SECOND'),joined=Promise.all([first,second])
    await Promise.race([ready.promise,joined.then(()=>{throw Error('Both model calls must enter before release')})])
    release.release();const runs=await joined;await f.runtime.telemetryFlush()
    expect(f.models.execute).toHaveBeenCalledTimes(2)
    for(const run of runs){const root=run.traceSegments![0]!.trace,core=f.wire.spans().filter(s=>s.traceId===root.traceId&&s.name!=='jevable.storage.journal.transaction'),journals=journalSpans(f.wire).filter(s=>s.traceId===root.traceId)
      expect(journals.length).toBeGreaterThan(10);expect(journals.every(s=>core.some(parent=>parent.spanId===s.parent))).toBe(true)
      expect(core.filter(s=>s.name==='jevable.model')).toHaveLength(1)
    }
    expect(runs[0]!.traceSegments![0]!.trace.traceId).not.toBe(runs[1]!.traceSegments![0]!.trace.traceId)
  })
  it.each([0,1].flatMap(sampleRatio=>(['step','continue','approval','cancel','recover'] as const).map(mode=>({sampleRatio,mode}))))(
    'held owner-control acknowledgement does not admit downstream work ($sampleRatio, $mode)',async({sampleRatio,mode})=>{
      const f=await runtimeFixture({sampleRatio}),id=randomUUID(),requestId=randomUUID(),failure=new JournalError('commit-uncertain')
      let before:LocalRun
      if(mode==='approval')before=await f.runtime.run(approval,{message:'PRIVATE_REVIEW'},{id})
      else if(mode==='recover'){
        f.setFailure(kind=>{const state=f.rows.get(id)?.record.state;if(kind==='node-result'&&state?.status==='executing'&&state.next==='model')throw failure})
        await expect(f.runtime.run(modelSource,'PRIVATE_INPUT',{id})).rejects.toBe(failure)
        before=structuredClone(f.rows.get(id)!.record);f.setFailure(undefined)
      }else before=await f.runtime.run(echo,'PRIVATE_INPUT',{id,paused:true})
      await f.runtime.telemetryFlush()
      const firstPacket=f.wire.packets.length,gate=held(),entered=held(),kind=mode==='approval'?'approval-decided':mode==='cancel'?'cancellation-requested':'execution-requested'
      let heldCount=0,terminal=false
      f.setAcknowledgement(async writeKind=>{if(writeKind===kind){heldCount++;entered.release();await gate.promise}})
      const invoke=()=>mode==='approval'
        ?before.state.status==='waiting'?f.runtime.decide(id,before.state.attempt.id,'approve','local:test'):Promise.reject(Error('Missing wait'))
        :mode==='cancel'?f.runtime.cancel(id,requestId,'local:test')
        :f.runtime.advance(id,{requestId,mode,expectedCheckpointSha256:executionCheckpointHash(before)},'local:test')
      // Capture failure immediately and always release the simulated acknowledgement before cleanup.
      const pending=f.runtime.withTraceParent(parent,invoke).then(value=>{terminal=true;return {value,error:undefined}},error=>{terminal=true;return {value:undefined,error}})
      try{
        await vi.waitFor(()=>expect(heldCount).toBe(1),{timeout:1500,interval:5});await entered.promise
        expect(terminal).toBe(false)
        const committed=structuredClone(f.rows.get(id)!),segmentCount=committed.record.traceSegments?.length??0
        expect(committed.events.at(-1)?.kind).toBe(kind)
        expect(committed.record.state.steps).toHaveLength(before.state.steps.length+(mode==='approval'?1:0))
        expect(segmentCount).toBe((before.traceSegments?.length??0)+(mode==='approval'?1:0))
        expect(f.models.execute).toHaveBeenCalledTimes(mode==='recover'?1:0)
        expect(f.models.recover).toHaveBeenCalledTimes(mode==='recover'?1:0)
        for(let i=0;i<2;i++){
          await f.runtime.telemetryFlush();expect(terminal).toBe(false);expect(f.rows.get(id)).toEqual(committed)
          const packets=f.wire.packets.slice(firstPacket),logs=packets.filter(p=>p.route==='/v1/logs').flatMap(p=>logRecords(p.bytes)),
            spans=packets.filter(p=>p.route==='/v1/traces').flatMap(p=>traceRecords(p.bytes))
          expect(logs.every(l=>l.event==='jevable.storage.journal.transaction.ended')).toBe(true)
          expect(spans.every(s=>s.name==='jevable.storage.journal.transaction')).toBe(true)
          // Approval owns its live segment already; other control intents still have only the request parent.
          if(sampleRatio&&mode==='approval')expect(spans.filter(s=>s.attributes['jevable.storage.transaction.kind']==='write').every(s=>s.parent===committed.record.traceSegments!.at(-1)!.trace.spanId)).toBe(true)
          for(const packet of packets)expect(packet.bytes.includes(Buffer.from('PRIVATE_'))).toBe(false)
        }
        gate.release();const outcome=await pending
        expect(outcome.error).toBeUndefined();expect(outcome.value).toBeDefined();const result=outcome.value!
        expect(result.state.status).toBe(mode==='continue'||mode==='approval'?'completed':mode==='cancel'?'cancelled':'paused')
        expect(result.state.steps).toHaveLength(mode==='step'?1:mode==='continue'?2:mode==='approval'?3:mode==='recover'?2:0)
        expect(f.models.execute).toHaveBeenCalledTimes(mode==='recover'?1:0);expect(f.models.recover).toHaveBeenCalledTimes(mode==='recover'?1:0)
        expect(heldCount).toBe(1);await f.runtime.telemetryFlush()
        const packets=f.wire.packets.slice(firstPacket),logs=packets.filter(p=>p.route==='/v1/logs').flatMap(p=>logRecords(p.bytes)),
          spans=packets.filter(p=>p.route==='/v1/traces').flatMap(p=>traceRecords(p.bytes))
        expect(logs.filter(l=>l.event==='jevable.execution.segment.ended')).toHaveLength(1)
        const expectedNodes=mode==='continue'?2:mode==='step'||mode==='approval'?1:0
        expect(logs.filter(l=>l.event==='jevable.node.attempt.ended')).toHaveLength(expectedNodes)
        const segment=result.traceSegments!.at(-1)!,parentId=mode==='approval'?segment.trace.spanId:'2'.repeat(16)
        const writes=logs.filter(l=>l.event==='jevable.storage.journal.transaction.ended'&&l.attributes['jevable.storage.transaction.kind']==='write')
        expect(writes.length).toBeGreaterThan(0)
        if(sampleRatio){
          expect(spans.filter(s=>s.name==='jevable.storage.journal.transaction'&&s.parent===parentId&&s.attributes['jevable.storage.transaction.kind']==='write').length).toBeGreaterThan(0)
          expect(spans.find(s=>s.spanId===segment.trace.spanId)?.parent).toBe('2'.repeat(16))
          for(const log of logs)expect(spans.some(s=>s.traceId===log.traceId&&s.spanId===log.spanId)).toBe(true)
        }else expect(spans).toHaveLength(0)
        for(const packet of packets)expect(packet.bytes.includes(Buffer.from('PRIVATE_'))).toBe(false)
        const retained=structuredClone(f.rows.get(id)!),models=vi.mocked(f.models.execute).mock.calls.length,recoveries=vi.mocked(f.models.recover!).mock.calls.length
        if(mode!=='approval'){
          expect(await f.runtime.withTraceParent(parent,invoke)).toEqual(result)
          expect(f.rows.get(id)).toEqual(retained);expect(f.models.execute).toHaveBeenCalledTimes(models);expect(f.models.recover).toHaveBeenCalledTimes(recoveries)
        }
      }finally{gate.release();await pending;f.setAcknowledgement(undefined)}
    })
})
