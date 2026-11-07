import {expect,it,vi} from 'vitest'
import {EventEmitter} from 'node:events'
import {randomUUID} from 'node:crypto'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {startRuntimeService} from '../src/http/service.ts'
import {startRuntimeServer, type RuntimeServiceHost} from '../src/http/server.ts'
import {runServiceProcess} from '../src/http/process.ts'
import {PROTOCOL_VERSION} from '../src/capabilities.ts'

it('omits resource identity when telemetry is disabled without initializing exporters', async () => {
 const service=await startRuntimeService({runtime:{dataDirectory:await mkdtemp(join(tmpdir(),'jevable-disabled-resource-'))},token:'a'.repeat(64),actor:'fixture'})
 try{
  expect(service).not.toHaveProperty('telemetryResource')
  const response=await fetch(service.url+'/v1/health',{headers:{authorization:'Bearer '+'a'.repeat(64),'x-jevable-protocol':PROTOCOL_VERSION}})
  expect(response.status).toBe(200)
  expect((await response.json()).runtime.telemetry).toEqual({enabled:false,signals:[]})
 }finally{await service.close();await service.closed}
})

it.each(['throw','invalid','extra','missing','valid'] as const)('contains optional diagnostic host metadata: %s', async mode => {
 const id=randomUUID(),supplied={serviceInstanceId:id},close=vi.fn(async()=>{})
 const host:RuntimeServiceHost={capabilities:()=>({}),withTraceParent:(_parent,work)=>work(),close,
  telemetryResource:()=>{
   if(mode==='throw')throw Error('PRIVATE_DIAGNOSTIC_ERROR')
   if(mode==='invalid')return {serviceInstanceId:'PRIVATE_INVALID_ID'}
   if(mode==='extra')return {...supplied,private:'PRIVATE_EXTRA'}
   if(mode==='missing')return undefined
   return supplied
  }}
 const service=await startRuntimeServer({token:'b'.repeat(64),actor:'fixture'},async()=>host)
 try{
  if(mode==='valid'){
   expect(service.telemetryResource).toEqual({serviceInstanceId:id})
   supplied.serviceInstanceId=randomUUID()
   expect(service.telemetryResource?.serviceInstanceId).toBe(id)
  }else expect(service).not.toHaveProperty('telemetryResource')
  expect(JSON.stringify(service)).not.toContain('PRIVATE_')
 }finally{await service.close();await service.closed}
 expect(close).toHaveBeenCalledTimes(1)
})

it.each([false,true])('preserves optional resource metadata in the ordinary CLI readiness receipt: %s', async enabled => {
 const signals=new EventEmitter(),done=Promise.withResolvers<void>(),receipts:any[]=[]
 const resource={serviceInstanceId:randomUUID()}
 const service={url:'http://127.0.0.1:1234',instanceId:randomUUID(),protocol:PROTOCOL_VERSION,transport:'loopback-http',listener:{address:'127.0.0.1',port:1234},closed:done.promise,
  close:async()=>{done.resolve();return {status:'closed' as const,activeRequests:0}},...(enabled?{telemetryResource:resource}:{})}
 const task=runServiceProcess(async()=>service,'sqlite',value=>receipts.push(value),1000,signals)
 await Promise.resolve()
 expect(receipts[0].status).toBe('ready')
 expect(receipts[0].instanceId).toBe(service.instanceId)
 if(enabled)expect(receipts[0].telemetryResource).toEqual(resource)
 else expect(receipts[0]).not.toHaveProperty('telemetryResource')
 signals.emit('SIGTERM');expect(await task).toBe(0)
 expect(receipts.at(-1).status).toBe('closed')
})
