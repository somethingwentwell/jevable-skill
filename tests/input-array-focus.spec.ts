import {describe,expect,it} from 'vitest'
import {JSDOM} from 'jsdom'
import {inputControlsHtml,liveInputControls} from '../src/preview/input-controls.ts'
import {schemaInputTools} from '../src/preview/input-model.ts'

// Real DOM/serialized-controller regression, not browser or screen-reader proof.
function fixture(schema: unknown, input: unknown) {
  const dom=new JSDOM(inputControlsHtml,{runScripts:'outside-only'})
  dom.window.TextEncoder=TextEncoder
  const doc=dom.window.document,json=doc.getElementById('live-input') as HTMLTextAreaElement
  json.value=JSON.stringify(input)
  const controller=dom.window.eval(`(${liveInputControls.toString()})(${JSON.stringify(schema)},(${schemaInputTools.toString()})())`) as ReturnType<typeof liveInputControls>
  const buttons=(name: string)=>[...doc.querySelectorAll<HTMLButtonElement>('#input-fields button')].filter(b=>b.textContent===name)
  const fieldValue=()=> (doc.activeElement as HTMLInputElement).value
  const activate=(name: string,index=0)=>{const b=buttons(name)[index]!;b.focus();b.click()}
  return {dom,doc,json,controller,buttons,fieldValue,activate}
}
describe('array edit keyboard focus without submission',()=>{
  it('focuses the newly added scalar including when Add reaches its limit',()=>{
    const f=fixture({type:'array',items:{type:'string'},maxItems:2},['first'])
    try{f.activate('Add item');expect(f.doc.activeElement?.tagName).toBe('TEXTAREA');expect(f.fieldValue()).toBe('');expect(f.buttons('Add item')[0]?.disabled).toBe(true);expect(f.controller.read()).toEqual(['first',''])}finally{f.dom.window.close()}
  })
  it.each([0,1,2])('removing row %s focuses the next row or final remaining row',index=>{
    const f=fixture({type:'array',items:{type:'string'}},['first','second','third'])
    try{f.activate(`Remove item ${index+1}`);expect(f.fieldValue()).toBe(['second','third','second'][index]);expect(f.controller.read()).toEqual(['first','second','third'].filter((_,i)=>i!==index))}finally{f.dom.window.close()}
  })
  it('focuses Add after removing the only row, without silently restoring it',()=>{
    const f=fixture({type:'array',items:{type:'string'},minItems:1},['first'])
    try{f.activate('Remove item 1');expect(f.doc.activeElement).toBe(f.buttons('Add item')[0]);expect(()=>f.controller.read()).toThrow('Include at least 1 item.');expect(f.json.value).toBe('["first"]')}finally{f.dom.window.close()}
  })
  it('uses the exact nested array path despite repeated Add/item labels',()=>{
    const f=fixture({type:'object',properties:{first:{type:'array',items:{type:'string'}},second:{type:'object',properties:{rows:{type:'array',items:{type:'object',required:['name'],properties:{name:{type:'string'}}}}}}}}, {first:['untouched'],second:{rows:[{name:'original'}]}})
    try{f.activate('Add item',1);expect(f.doc.activeElement?.tagName).toBe('TEXTAREA');expect(f.controller.read()).toEqual({first:['untouched'],second:{rows:[{name:'original'},{name:''}]}});expect(f.doc.activeElement?.closest('fieldset')?.querySelector('legend')?.textContent).toBe('name')}finally{f.dom.window.close()}
  })
  it('keeps focus and the complete invalid draft if a different numeric field prevents the edit',()=>{
    const f=fixture({type:'object',properties:{amount:{type:'number'},rows:{type:'array',items:{type:'string'}}}}, {amount:2,rows:['retained']})
    try{const numeric=f.doc.querySelector<HTMLInputElement>('#input-fields input[type="text"]')!;numeric.value='invalid';const add=f.buttons('Add item')[0]!;f.activate('Add item');expect(f.doc.activeElement).toBe(add);expect(numeric.value).toBe('invalid');expect(f.buttons('Remove item 2')).toHaveLength(0);expect(f.json.value).toBe('{"amount":2,"rows":["retained"]}')}finally{f.dom.window.close()}
  })
  it('does not steal focus for a programmatic click while another control remains focused',()=>{
    const f=fixture({type:'array',items:{type:'string'}},['first'])
    try{const jsonButton=f.doc.getElementById('input-use-json')!;jsonButton.focus();f.buttons('Add item')[0]!.click();expect(f.doc.activeElement).toBe(jsonButton);expect(f.controller.read()).toEqual(['first',''])}finally{f.dom.window.close()}
  })
  it('focuses a labelled fieldset for an item with no editable fields',()=>{
    const f=fixture({type:'array',items:{type:'null'},maxItems:2},[null])
    try{f.activate('Add item');expect(f.doc.activeElement?.tagName).toBe('FIELDSET');expect(f.doc.activeElement?.querySelector('legend')?.textContent).toBe('Item 2');expect(f.controller.read()).toEqual([null,null])}finally{f.dom.window.close()}
  })
})
