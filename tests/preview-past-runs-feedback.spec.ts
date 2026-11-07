import {afterEach,describe,expect,it,vi} from 'vitest'
import {JSDOM} from 'jsdom'
import {livePreviewBrowser,renderLivePage} from '../src/preview/live-page.ts'
import {workspaceScript} from '../src/preview/workspace.generated.ts'

// Actual serialized controller and optional bundled React shell in a DOM.
// Synthetic protocol/clock only: not actual-browser or screen-reader acceptance.
const instance='00000000-0000-4000-8000-000000000000',protocol='jevable/v1alpha1'
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222'
const initial=Date.parse('2026-10-15T00:00:00.000Z'),token='a'.repeat(64),replacement='b'.repeat(64)
const windows:JSDOM[]=[]
afterEach(()=>windows.splice(0).forEach(dom=>dom.window.close()))
const settle=async()=>{for(let n=0;n<15;n++)await new Promise(resolve=>setImmediate(resolve))}
function held(){let resolve!:(response:Response)=>void,reject!:(error:Error)=>void;const promise=new Promise<Response>((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
function reply(result:unknown,status=200,code='conflict'){
  return new Response(JSON.stringify({instanceId:instance,...(status===200?{result}:{code})}),{status,headers:{'content-type':'application/json','x-jevable-protocol':protocol}})
}
async function fixture(shell=false,pending=false){
  const dom=new JSDOM(renderLivePage(instance,protocol).html,{runScripts:'outside-only',pretendToBeVisual:true,url:'http://127.0.0.1:3000/'})
  windows.push(dom);let now=initial,nextTimer=0
  const timers=new Map<number,{due:number;callback:()=>void}>()
  dom.window.Date.now=()=>now
  // React's browser scheduler needs native UI timers. Controlled deadlines are
  // tested without the shell; never hold its mounting work in our fake clock.
  if(!shell){
    dom.window.setTimeout=((callback:()=>void,delay=0)=>{const n=++nextTimer;timers.set(n,{due:now+delay,callback});return n}) as typeof dom.window.setTimeout
    dom.window.clearTimeout=(n?:number)=>{if(n!==undefined)timers.delete(n)}
  }
  const key=`jevable.preview.${instance}`,original={token,expiresAt:new Date(initial+3600000).toISOString(),...(pending?{
    runId:id,cancelId:other,pendingControl:{id,requestId:'33333333-3333-4333-8333-333333333333',expectedCheckpointSha256:'c'.repeat(64),mode:'step',breakpoints:['review']},
    batchId:'44444444-4444-4444-8444-444444444444',pendingBatch:true,batchTriggerMode:'api',testId:'55555555-5555-4555-8555-555555555555'
  }:{})}
  dom.window.sessionStorage.setItem(key,JSON.stringify(original))
  const calls:{path:string;command:any}[]=[],responses=new Map<string,((signal:AbortSignal)=>Promise<Response>)[]>()
  const runs=[{id,status:'paused'},{id:other,status:'completed'}]
  const fetch=vi.fn(async(path:string,init:RequestInit)=>{
    const command=JSON.parse(String(init.body));calls.push({path,command})
    const forced=responses.get(path.endsWith('bootstrap')?'bootstrap':command.operation)?.shift()
    if(forced)return forced(init.signal as AbortSignal)
    if(path.endsWith('bootstrap'))return reply({token:replacement,expiresAt:new Date(now+3600000).toISOString()})
    if(path.endsWith('logout'))return reply({status:'disconnected'})
    if(command.operation==='view')return reply({project:{id:instance,generation:1,revision:'d'.repeat(64)},preview:{},entry:{local:true,api:false},readiness:{runtimeReadiness:'ready'},inputSchema:{type:'object'},sample:{message:'Synthetic sample'}})
    if(command.operation==='runs')return reply({runs})
    if(command.operation==='show')return reply({id:command.id,status:command.id===id?'paused':'completed',checkpointSha256:'c'.repeat(64),steps:[]})
    if(command.operation==='run')return reply({id:command.id,status:'completed'})
    throw Error('Unexpected test operation: '+command.operation)
  })
  Object.assign(dom.window,{fetch,TextEncoder,TextDecoder})
  Object.defineProperty(dom.window,'matchMedia',{value:()=>({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}})})
  dom.window.eval(`(${livePreviewBrowser.toString()})(()=>({setExecution(){}}),${JSON.stringify(instance)},${JSON.stringify(protocol)})`)
  if(shell)dom.window.eval(workspaceScript)
  const get=<T extends HTMLElement=HTMLElement>(name:string)=>dom.window.document.getElementById(name) as T
  await vi.waitFor(()=>expect(get('live-message').textContent).toContain('Session open'))
  await settle()
  if(shell){
    await vi.waitFor(()=>expect(get('tab-history')).not.toBeNull())
    get<HTMLButtonElement>('tab-history').click()
    await vi.waitFor(()=>expect(get('live-history-status').closest('[hidden]')).toBeNull())
  }
  return{dom,get,key,original,calls,runs,
    saved:()=>dom.window.sessionStorage.getItem(key),
    list:()=>[...get<HTMLSelectElement>('live-history').options].map(option=>({id:option.value,text:option.textContent})),
    refresh:()=>get<HTMLButtonElement>('live-refresh-history').click(),
    force:(operation:string,response:(signal:AbortSignal)=>Promise<Response>)=>responses.set(operation,[...responses.get(operation)??[],response]),
    event:(name:string)=>dom.window.dispatchEvent(new dom.window.Event(name)),
    clock(ms:number){now+=ms;for(let n=0;n<100;n++){const task=[...timers].find(([,v])=>v.due<=now);if(!task)return;timers.delete(task[0]);task[1].callback()}throw Error('Unbounded timer queue')},
  }
}
const status=(f:Awaited<ReturnType<typeof fixture>>)=>f.get('live-history-status').textContent
const operations=(f:Awaited<ReturnType<typeof fixture>>)=>f.calls.map(call=>call.command.operation)
describe('Past runs feedback belongs to its read, not workflow or approval actions',()=>{
  it.each([false,true])('lost read and explicit successful refresh replace only their local feedback (shell=%s)',async shell=>{
    const f=await fixture(shell),saved=f.saved(),list=f.list(),main=f.get('live-message').textContent
    f.get<HTMLInputElement>('live-authorize').checked=true
    f.get<HTMLTextAreaElement>('live-input').value='PRIVATE_UNSENT_DRAFT'
    const disabled=f.get<HTMLButtonElement>('live-run').disabled
    f.force('runs',async()=>{throw Error('PRIVATE_FETCH '+token)});f.refresh();await settle()
    expect(status(f)).toContain('Could not refresh past runs');expect(status(f)).not.toContain('PRIVATE_');expect(status(f)).not.toContain(token)
    expect(f.get('live-message').textContent).toBe(main);expect(f.list()).toEqual(list);expect(f.saved()).toBe(saved)
    expect(f.get('run-history').getAttribute('aria-busy')).toBe('false')
    f.refresh();await settle()
    expect(status(f)).toContain('Past runs refreshed');expect(status(f)).not.toContain('Could not')
    expect(f.get('live-message').textContent).toBe(main);expect(f.saved()).toBe(saved);expect(f.list()).toEqual(list)
    expect(f.get<HTMLInputElement>('live-authorize').checked).toBe(true);expect(f.get<HTMLTextAreaElement>('live-input').value).toBe('PRIVATE_UNSENT_DRAFT')
    expect(f.get<HTMLButtonElement>('live-run').disabled).toBe(disabled);expect(operations(f)).toEqual(['view','runs','runs','runs'])
    expect(f.get('live-history-status').getAttribute('role')).toBe('status');expect(f.get('live-history-status').getAttribute('aria-live')).toBe('polite')
    if(shell)expect(f.get('live-history-status').closest('[hidden]')).toBeNull()
  })
  it('an uncertain run submission remains visible with its original retained identity through failed and successful list reads',async()=>{
    const f=await fixture();f.force('run',async()=>{throw Error('PRIVATE_RUN_FAILURE')})
    f.get<HTMLButtonElement>('live-run').click();await settle()
    const warning=f.get('live-message').textContent,saved=f.saved(),run=f.calls.find(call=>call.command.operation==='run')!.command
    expect(warning).toContain('Your workflow may still be running');expect(JSON.parse(saved!)).toHaveProperty('runId',run.id)
    f.force('runs',async()=>{throw Error('PRIVATE_LIST_FAILURE')});f.refresh();await settle()
    expect(status(f)).toContain('Could not refresh');expect(f.get('live-message').textContent).toBe(warning)
    f.refresh();await settle()
    expect(status(f)).toContain('Past runs refreshed');expect(f.get('live-message').textContent).toBe(warning);expect(f.saved()).toBe(saved)
    expect(operations(f).filter(op=>op==='run')).toHaveLength(1);expect(operations(f).filter(op=>op==='runs')).toHaveLength(3)
    expect(operations(f).filter(op=>['decide','advance','cancel','inspect'].includes(op))).toEqual([])
  })
  it('does not consume pending control, cancel, batch or test identities or authorize a continuation',async()=>{
    const f=await fixture(false,true),saved=f.saved(),main='Your earlier action is unresolved. Inspect it before trying again.'
    f.get('live-message').textContent=main
    const controls=['live-run','live-step','live-continue','live-retry-control'].map(name=>f.get<HTMLButtonElement>(name).disabled)
    f.force('runs',async()=>{throw Error('PRIVATE_FAILURE')});f.refresh();await settle();f.refresh();await settle()
    expect(f.saved()).toBe(saved);expect(f.get('live-message').textContent).toBe(main)
    expect(['live-run','live-step','live-continue','live-retry-control'].map(name=>f.get<HTMLButtonElement>(name).disabled)).toEqual(controls)
    expect(f.get<HTMLSelectElement>('live-history').value).toBe(id)
    expect(operations(f)).toEqual(['view','runs','show','runs','runs'])
  })
  it.each(['stream','json','headers','shape','partial-list'] as const)('sanitizes %s failure and leaves the last known list atomic',async kind=>{
    const f=await fixture(),before=f.list(),saved=f.saved(),main=f.get('live-message').textContent
    f.force('runs',async()=>{
      if(kind==='stream')return new Response(new ReadableStream({start(controller){controller.error(Error('PRIVATE_STREAM'))}}),{headers:{'content-type':'application/json','x-jevable-protocol':protocol}})
      if(kind==='json')return new Response('{PRIVATE_JSON '+token,{headers:{'content-type':'application/json','x-jevable-protocol':protocol}})
      if(kind==='headers')return new Response('PRIVATE_BODY',{headers:{'content-type':'text/html'}})
      return reply(kind==='shape'?{runs:'PRIVATE_BAD_LIST'}:{runs:[{id:other,status:'completed'},null]})
    });f.refresh();await settle()
    expect(status(f)).toContain('Could not refresh');expect(status(f)).not.toContain('PRIVATE_');expect(status(f)).not.toContain(token)
    expect(f.list()).toEqual(before);expect(f.saved()).toBe(saved);expect(f.get('live-message').textContent).toBe(main)
    expect(f.get('run-history').getAttribute('aria-busy')).toBe('false');expect(operations(f)).toEqual(['view','runs','runs'])
  })
  it('keeps the fifteen-second timeout and requires an explicit retry',async()=>{
    const f=await fixture(),list=f.list();f.force('runs',signal=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('PRIVATE_ABORT')))))
    f.refresh();await settle();expect(status(f)).toBe('Loading past runs…');expect(f.get('run-history').getAttribute('aria-busy')).toBe('true')
    f.clock(14999);await settle();expect(status(f)).toBe('Loading past runs…')
    f.clock(1);await settle();expect(status(f)).toContain('Could not refresh');expect(f.list()).toEqual(list)
    f.clock(30000);await settle();expect(operations(f)).toEqual(['view','runs','runs'])
    f.refresh();await settle();expect(status(f)).toContain('Past runs refreshed');expect(operations(f)).toEqual(['view','runs','runs','runs'])
  })
  it.each(['success','failure'] as const)('an older %s cannot overwrite a newer failure',async oldOutcome=>{
    const f=await fixture(),old=held(),before=f.list();f.force('runs',()=>old.promise);f.refresh();await settle()
    f.force('runs',async()=>{throw Error('PRIVATE_NEW_FAILURE')});f.refresh();await settle()
    if(oldOutcome==='success')old.resolve(reply({runs:[]}));else old.reject(Error('PRIVATE_OLD_FAILURE'))
    await settle();expect(status(f)).toContain('Could not refresh');expect(f.list()).toEqual(before)
    expect(f.get('run-history').getAttribute('aria-busy')).toBe('false');expect(operations(f)).toEqual(['view','runs','runs','runs'])
  })
  it('older failure/finally cannot clear the latest busy state or later successful result',async()=>{
    const f=await fixture(),old=held(),latest=held();f.force('runs',()=>old.promise);f.refresh();f.force('runs',()=>latest.promise);f.refresh();await settle()
    old.reject(Error('PRIVATE_OLD_FAILURE'));await settle()
    expect(status(f)).toBe('Loading past runs…');expect(f.get('run-history').getAttribute('aria-busy')).toBe('true')
    latest.resolve(reply({runs:[]}));await settle();expect(status(f)).toContain('No past runs yet')
    expect(f.list()).toEqual([{id:'',text:'Choose a past run'}]);expect(f.get('run-history').getAttribute('aria-busy')).toBe('false')
  })
  it.each(['success','failure'] as const)('a held %s cannot restore feedback/list after pagehide/pageshow',async outcome=>{
    const f=await fixture(),old=held(),before=f.list();f.force('runs',()=>old.promise);f.refresh();await settle()
    f.event('pagehide');f.event('pageshow')
    if(outcome==='success')old.resolve(reply({runs:[]}));else old.reject(Error('PRIVATE_OLD_FAILURE'))
    await settle();expect(status(f)).toBe('');expect(f.list()).toEqual(before)
    expect(f.get('run-history').getAttribute('aria-busy')).toBe('false');expect(operations(f)).toEqual(['view','runs','runs'])
  })
  it('a read dispatched while hidden cannot publish after the page returns',async()=>{
    const f=await fixture(),old=held(),before=f.list();f.event('pagehide');f.force('runs',()=>old.promise);f.refresh();f.event('pageshow')
    old.resolve(reply({runs:[]}));await settle();expect(status(f)).toBe('');expect(f.list()).toEqual(before)
    expect(f.get('run-history').getAttribute('aria-busy')).toBe('false')
  })
  it.each(['success','failure'] as const)('an old-session %s cannot overwrite the explicitly reconnected list or feedback',async outcome=>{
    const f=await fixture(),old=held();f.force('runs',()=>old.promise);f.refresh();await settle()
    f.force('runs',async()=>reply(undefined,401,'unauthorized'));f.refresh();await settle()
    expect(f.get('live-session').hidden).toBe(true);expect(status(f)).toBe('')
    f.get<HTMLInputElement>('live-token').value='f'.repeat(64);f.get<HTMLButtonElement>('live-connect').click();await settle()
    const text=status(f),saved=f.saved(),before=f.list();expect(text).toContain('Past runs refreshed');expect(JSON.parse(saved!)).toHaveProperty('token',replacement)
    if(outcome==='success')old.resolve(reply({runs:[]}));else old.reject(Error('PRIVATE_OLD_SESSION'))
    await settle();expect(status(f)).toBe(text);expect(f.saved()).toBe(saved);expect(f.list()).toEqual(before)
    expect(f.get('live-message').textContent).toContain('Session open')
  })
  it('expiry clears local pending feedback and leaves retained pending action identities without redispatch',async()=>{
    const f=await fixture(false,true),old=held();f.force('runs',()=>old.promise);f.refresh();await settle()
    f.clock(3600001);await settle();expect(status(f)).toBe('');expect(f.get('live-session').hidden).toBe(true)
    const saved=f.saved();expect(JSON.parse(saved!)).toEqual({...f.original,reconnectRequired:true})
    old.resolve(reply({runs:[]}));await settle();expect(status(f)).toBe('');expect(f.saved()).toBe(saved)
    expect(operations(f)).toEqual(['view','runs','show','runs'])
  })
  it('selection invalidates the pending list display without undoing its explicit new run context',async()=>{
    const f=await fixture(),old=held(),before=f.list();f.force('runs',()=>old.promise);f.refresh();await settle()
    f.get<HTMLSelectElement>('live-history').value=other;f.get('live-history').dispatchEvent(new f.dom.window.Event('change'));await settle()
    expect(status(f)).toBe('');old.resolve(reply({runs:[]}));await settle()
    expect(f.list()).toEqual(before);expect(f.get<HTMLSelectElement>('live-history').value).toBe(other)
    expect(JSON.parse(f.saved()!)).toHaveProperty('runId',other);expect(f.get('live-status').textContent).toContain('completed')
    expect(operations(f)).toEqual(['view','runs','runs','show'])
  })
})
