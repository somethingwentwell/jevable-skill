import { describe,expect,it,vi } from 'vitest'
import { withObservationScope,type ObservationScope } from '../src/providers/observation-scope.ts'
import { observeModelTry } from '../src/providers/try-observation.ts'
import type { ModelExecutionContext,ModelTryObservation } from '../src/runtime/model-port.ts'
import { runTrace } from '../src/runtime/run-types.ts'
const context=(observer:ModelTryObservation):ModelExecutionContext=>({trace:runTrace.parse({traceId:'1'.repeat(32),spanId:'2'.repeat(16),traceFlags:1}),startTry:()=>observer})
describe('optional model try journal scope cannot change persistence work',()=>{
  it('keeps synchronous value identity and executes once without a hook',()=>{const value={},work=vi.fn(()=>value);expect(withObservationScope(undefined,work)).toBe(value);expect(work).toHaveBeenCalledOnce()})
  it('keeps Promise identity without waiting on or replacing it',()=>{const value=Promise.resolve({}),work=vi.fn(()=>value);expect(withObservationScope(work=>work(),work)).toBe(value);expect(work).toHaveBeenCalledOnce()})
  it.each(['before','after'] as const)('contains hook failure %s actual work without replay',phase=>{
    const value={},work=vi.fn(()=>value),scope:ObservationScope=callback=>{if(phase==='before')throw Error('diagnostic');callback();throw Error('diagnostic')}
    expect(withObservationScope(scope,work)).toBe(value);expect(work).toHaveBeenCalledOnce()
  })
  it('cannot duplicate work when the hook calls it repeatedly',()=>{const value={},work=vi.fn(()=>value)
    const scope:ObservationScope=callback=>{const result=callback();expect(callback()).toBe(result);return callback()}
    expect(withObservationScope(scope,work)).toBe(value);expect(work).toHaveBeenCalledOnce()})
  it('cannot replace a value returned by work',()=>{const value={},work=vi.fn(()=>value)
    const scope=(callback:()=>unknown)=>{callback();return {fake:true}}
    expect(withObservationScope(scope as ObservationScope,work)).toBe(value);expect(work).toHaveBeenCalledOnce()})
  it('cannot prevent work by ignoring the callback',()=>{const value={},work=vi.fn(()=>value)
    expect(withObservationScope((()=>undefined) as ObservationScope,work)).toBe(value);expect(work).toHaveBeenCalledOnce()})
  it('cannot mask an actual synchronous persistence error even if the hook swallows it',()=>{
    const failure=Error('actual storage'),work=vi.fn(()=>{throw failure}),scope:ObservationScope=callback=>{try{return callback()}catch{ return undefined as never }}
    expect(()=>withObservationScope(scope,work)).toThrow(failure);expect(work).toHaveBeenCalledOnce()
  })
  it('preserves the actual rejection when diagnostics return a different rejected Promise',async()=>{
    const failure=Error('actual storage'),value=Promise.reject(failure),work=vi.fn(()=>value)
    const scope=((callback:()=>unknown)=>{callback();return Promise.reject(Error('diagnostic'))}) as ObservationScope
    const observed=withObservationScope(scope,work);expect(observed).toBe(value);await expect(observed).rejects.toBe(failure)
    await Promise.resolve();expect(work).toHaveBeenCalledOnce()
  })
  it('a deferred diagnostic callback cannot cause a later duplicate persistence operation',async()=>{
    const value={},work=vi.fn(()=>value);let delayed:(()=>unknown)|undefined
    const scope=((callback:()=>unknown)=>{delayed=callback;return Promise.resolve().then(callback)}) as ObservationScope
    expect(withObservationScope(scope,work)).toBe(value);await Promise.resolve();expect(delayed?.()).toBe(value);expect(work).toHaveBeenCalledOnce()
  })
  it('contains a throwing optional scope getter',()=>{const observer:ModelTryObservation={end(){}}
    Object.defineProperty(observer,'withJournalScope',{get(){throw Error('diagnostic getter')}})
    const value={},work=vi.fn(()=>value);expect(observeModelTry(context(observer),'try',1).scope(work)).toBe(value);expect(work).toHaveBeenCalledOnce()
  })
  it('snapshots the optional hook and preserves its receiver before awaits',()=>{
    const observer:ModelTryObservation={end(){},withJournalScope(work){expect(this).toBe(observer);return work()}}
    const observation=observeModelTry(context(observer),'try',1),replacement=vi.fn(()=>{throw Error('replacement')});observer.withJournalScope=replacement
    const value={},work=vi.fn(()=>value);expect(observation.scope(work)).toBe(value);expect(work).toHaveBeenCalledOnce();expect(replacement).not.toHaveBeenCalled()
  })
  it('an ended try does not reconstruct diagnostic lifetime or call end twice',()=>{
    const end=vi.fn(),observer:ModelTryObservation={end,withJournalScope:work=>work()},observation=observeModelTry(context(observer),'try',1)
    observation.end({outcome:'failed',dispatched:true,settled:true});const work=vi.fn(()=>42);expect(observation.scope(work)).toBe(42)
    observation.end({outcome:'completed',dispatched:true,settled:true});expect(end).toHaveBeenCalledOnce();expect(work).toHaveBeenCalledOnce()
  })
})
