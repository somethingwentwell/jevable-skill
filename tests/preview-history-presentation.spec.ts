import {afterEach,describe,expect,it,vi} from 'vitest'
import {JSDOM} from 'jsdom'
import {livePreviewBrowser,renderLivePage} from '../src/preview/live-page.ts'
import {workspaceScript} from '../src/preview/workspace.generated.ts'

// Real bundled presentation and serialized controller with controlled protocol
// replies. These are not actual-browser rendering or operation qualification.
const windows:JSDOM[]=[]
afterEach(()=>windows.splice(0).forEach(dom=>dom.window.close()))
const instance='00000000-0000-4000-8000-000000000000',protocol='jevable/v1alpha1'
const tick=()=>new Promise(resolve=>setTimeout(resolve,25))
async function shell(){
  const dom=new JSDOM(renderLivePage(instance,protocol).html,{runScripts:'outside-only',pretendToBeVisual:true,url:'http://127.0.0.1:3000/'})
  windows.push(dom);Object.assign(dom.window,{TextEncoder,matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}})})
  const get=<T extends HTMLElement=HTMLElement>(id:string)=>dom.window.document.getElementById(id) as T
  const controls=['live-history','live-refresh-history','model-history-load','model-history-prev','model-history-next',
    'notification-history-load','notification-history-next','notification-history-clear','live-run','live-review']
  const originals=new Map(controls.map(id=>[id,get(id)])),clicks:string[]=[],fetch=vi.fn()
  Object.assign(dom.window,{fetch})
  for(const id of controls)get(id).addEventListener('click',()=>clicks.push(id))
  // The mock owner sets admission; the shell must preserve it exactly.
  get<HTMLButtonElement>('notification-history-load').disabled=false
  dom.window.eval(workspaceScript);await vi.waitFor(()=>expect(get('tab-history')).not.toBeNull())
  get('live-login').hidden=true;get('live-session').hidden=false
  await vi.waitFor(()=>expect(dom.window.document.querySelector('.connection-state')?.textContent).toBe('Session open'))
  get('tab-history').click();await vi.waitFor(()=>expect(get('panel-history').hidden).toBe(false))
  const details=get<HTMLDetailsElement>('past-runs-technical'),summary=details.querySelector('summary')!
  const toggle=async()=>{summary.click();await tick()}
  return{dom,get,details,summary,toggle,originals,clicks,fetch}
}
describe('Past runs uses progressive disclosure without acquiring operation authority',()=>{
  it('starts with the list outside the closed technical disclosure and original controls mounted once',async()=>{
    const f=await shell()
    expect(f.details.open).toBe(false);expect(f.summary.textContent).toBe('Troubleshooting history')
    expect(f.get('run-history').closest('#past-runs-technical')).toBeNull()
    expect(f.get('model-history').closest('details')).toBe(f.details)
    expect(f.get('notification-history').closest('details')).toBe(f.details)
    for(const[id,element]of f.originals){expect(f.get(id)).toBe(element);expect(f.dom.window.document.querySelectorAll('#'+id)).toHaveLength(1)}
    expect(f.clicks).toEqual([]);expect(f.fetch).not.toHaveBeenCalled()
  })
  it('opening and closing only reveal/hide the same controls, without reading or clearing user work',async()=>{
    const f=await shell(),main='Your earlier action is unresolved. Inspect its original request.'
    f.get('live-message').textContent=main
    f.get<HTMLInputElement>('notification-history-created-from').value='2026-10-01T00:00:00.000Z'
    f.get('notification-history-message').textContent='Previously loaded metadata'
    f.get('model-history-message').textContent='Retained attempt metadata'
    f.get<HTMLTextAreaElement>('live-input').value='PRIVATE_UNSENT_DRAFT'
    f.get<HTMLInputElement>('live-authorize').checked=true
    const states=[...f.originals].map(([id])=>[id,f.get<HTMLButtonElement>(id).disabled])
    for(const expected of[true,false,true]){await f.toggle();expect(f.details.open).toBe(expected)}
    expect(f.get('live-message').textContent).toBe(main);expect(f.get('notification-history-message').textContent).toBe('Previously loaded metadata')
    expect(f.get('model-history-message').textContent).toBe('Retained attempt metadata')
    expect(f.get<HTMLInputElement>('notification-history-created-from').value).toBe('2026-10-01T00:00:00.000Z')
    expect(f.get<HTMLTextAreaElement>('live-input').value).toBe('PRIVATE_UNSENT_DRAFT');expect(f.get<HTMLInputElement>('live-authorize').checked).toBe(true)
    expect([...f.originals].map(([id])=>[id,f.get<HTMLButtonElement>(id).disabled])).toEqual(states)
    expect(f.clicks).toEqual([]);expect(f.fetch).not.toHaveBeenCalled()
  })
  it('preserves disclosure state and listeners across workspace navigation and observer updates',async()=>{
    const f=await shell();await f.toggle()
    for(const tab of['tab-tests','tab-publish','tab-settings','tab-workflow']){f.get(tab).click();await tick()}
    f.get('live-status').textContent='Run synthetic · paused';await tick();f.get('tab-history').click();await tick()
    expect(f.details.open).toBe(true);expect(f.get('panel-history').hidden).toBe(false)
    f.get<HTMLButtonElement>('notification-history-load').click()
    expect(f.clicks).toEqual(['notification-history-load']);expect(f.fetch).not.toHaveBeenCalled()
    expect(f.get('notification-history-load')).toBe(f.originals.get('notification-history-load'))
  })
})

async function controller(runs:{id:string;status:string;test?:{id:string;generation:number;sha256:string}}[]){
  const dom=new JSDOM(renderLivePage(instance,protocol).html,{runScripts:'outside-only',url:'http://127.0.0.1:3000/'})
  windows.push(dom);Object.assign(dom.window,{TextDecoder})
  const key=`jevable.preview.${instance}`,saved={token:'a'.repeat(64),expiresAt:'2099-01-01T00:00:00.000Z'}
  dom.window.sessionStorage.setItem(key,JSON.stringify(saved))
  const calls:any[]=[]
  dom.window.fetch=vi.fn(async(_path:unknown,init:RequestInit)=>{
    const command=JSON.parse(String(init.body));calls.push(command)
    const result=command.operation==='view'?{project:{id:instance,generation:1},preview:{},entry:{local:true,api:false},readiness:{runtimeReadiness:'ready'},inputSchema:{type:'string'},sample:'Synthetic sample'}
      :command.operation==='runs'?{runs}:command.operation==='show'?{id:command.id,status:'completed'}:undefined
    if(result===undefined)throw Error('Unexpected operation')
    return new Response(JSON.stringify({instanceId:instance,result}),{headers:{'content-type':'application/json','x-jevable-protocol':protocol}})
  }) as typeof dom.window.fetch
  dom.window.eval(`(${livePreviewBrowser.toString()})(()=>({setExecution(){}}),${JSON.stringify(instance)},${JSON.stringify(protocol)})`)
  const get=<T extends HTMLElement=HTMLElement>(id:string)=>dom.window.document.getElementById(id) as T
  await vi.waitFor(()=>expect(get('live-message').textContent).toContain('Session open'))
  return{dom,key,saved,calls,get,select:get<HTMLSelectElement>('live-history')}
}
describe('friendly run labels retain exact selection identities',()=>{
  it('marks only runs carrying a saved-test identity, so the assessment action is discoverable',async()=>{
    const plain='11111111-1111-4111-8111-111111111111',tested='22222222-2222-4222-8222-222222222222'
    const f=await controller([{id:plain,status:'completed'},
      {id:tested,status:'waiting',test:{id:'33333333-3333-4333-8333-333333333333',generation:2,sha256:'a'.repeat(64)}}])
    expect([...f.select.options].slice(1).map(option=>option.textContent)).toEqual([
      'Finished · 11111111','Needs your decision · saved test · 22222222'])
    expect(f.calls).toEqual([{operation:'view'},{operation:'runs'}])
  })
  it.each([
    ['completed','Finished'],['waiting','Needs your decision'],['paused','Paused'],['executing','Result not confirmed'],['failed','Needs attention'],['cancelled','Stopped'],
    ['PRIVATE_UNKNOWN_STATUS','Saved run'],['constructor','Saved run'],['__proto__','Saved run'],
  ])('labels %s without exposing unknown status strings or changing its UUID',async(status,label)=>{
    const id='11111111-1111-4111-8111-111111111111',f=await controller([{id,status}])
    expect(f.select.options).toHaveLength(2)
    const option=f.select.options[1]!
    expect(f.select.options[0]!.textContent).toBe('Choose a past run');expect(option.textContent).toBe(label+' · 11111111')
    expect(option.value).toBe(id);expect(option.title).toBe('Run '+id)
    expect(f.calls).toEqual([{operation:'view'},{operation:'runs'}]);expect(f.dom.window.sessionStorage.getItem(f.key)).toBe(JSON.stringify(f.saved))
  })
  it('uses full IDs for colliding prefixes and submits only the explicitly selected full identity',async()=>{
    const ids=['11111111-1111-4111-8111-111111111111','11111111-2222-4222-8222-222222222222'] as const,f=await controller(ids.map(id=>({id,status:'completed'})))
    expect([...f.select.options].slice(1).map(option=>option.textContent)).toEqual(ids.map(id=>'Finished · '+id))
    f.select.value=ids[1];f.select.dispatchEvent(new f.dom.window.Event('change'))
    await vi.waitFor(()=>expect(f.calls).toHaveLength(3))
    await vi.waitFor(()=>expect(f.get('live-status').textContent).toContain('completed'))
    expect(f.calls[2]).toEqual({operation:'show',id:ids[1]})
    expect(JSON.parse(f.dom.window.sessionStorage.getItem(f.key)!)).toHaveProperty('runId',ids[1])
    expect(f.calls.filter(call=>['run','decide','advance','cancel'].includes(call.operation))).toEqual([])
  })
})
