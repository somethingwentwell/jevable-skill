'use client';
import { useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from './animate-tabs'
import { JevableLogo } from './jevable-logo'

// Inspection-only presentation. Move original viewer/report nodes exactly once;
// never fetch, parse upload bytes, synthesize viewer clicks or obtain runtime authority.
const required = (id: string) => document.getElementById(id)!
function Slot({ id }: { id: string }) {
  const target = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = required(id), parent = element.parentNode!, next = element.nextSibling
    target.current!.append(element)
    return () => { parent.insertBefore(element, next?.parentNode === parent ? next : null) }
  }, [id])
  return <div ref={target} />
}
function ImportReview() {
  const [page, setPage] = useState('conversion')
  const needsRepair = required('validation').textContent?.startsWith('Invalid draft')
  const navigate = useRef(false)
  useLayoutEffect(() => {
    // Preserve the complete static viewer if this enhancement cannot mount.
    required('import-original').hidden = true
    return () => { required('import-original').hidden = false }
  }, [])
  useLayoutEffect(() => {
    if (page === 'diagram' && navigate.current) {
      navigate.current = false
      required('graph').focus()
    }
  }, [page])
  return <MotionConfig reducedMotion="user"><div className="workspace-app import-app">
    <a className="skip-link" href="#graph" onClick={event => {
      event.preventDefault(); navigate.current = true
      if (page === 'diagram') { navigate.current = false; required('graph').focus() }
      else setPage('diagram')
    }}>Skip to workflow</a>
    <header className="workspace-header">
      <div className="workspace-brand"><JevableLogo /><span>jevable<span className="brand-product">Import review</span></span></div>
      <div className="workspace-heading"><Slot id="import-heading" /></div>
      <span className="import-offline">Offline · inspection only</span>
    </header>
    <p className="import-context">{needsRepair ? 'This converted draft needs fixes before it can run.' : 'Review the converted steps before testing.'} No project was created and nothing has run.</p>
    <Tabs value={page} onValueChange={setPage}>
      <nav className="workspace-nav" aria-label="Import review views"><TabsList aria-label="Import review">
        <TabsTrigger value="conversion">Review conversion</TabsTrigger>
        <TabsTrigger value="diagram">Workflow</TabsTrigger>
        <TabsTrigger value="import-details">Details</TabsTrigger>
      </TabsList><span className="workspace-safety">Exploring never runs the workflow.</span></nav>
      <TabsContent value="conversion"><Slot id="import-review" /></TabsContent>
      <TabsContent value="diagram"><Slot id="import-diagram" /></TabsContent>
      <TabsContent value="import-details"><div className="import-details-page"><h2>Workflow identity and source</h2>
        <p>These values describe the converted draft, not a tested app or authenticated source-platform behavior.</p>
        <Slot id="import-technical" /><Slot id="import-source" /></div></TabsContent>
    </Tabs>
    <footer className="workspace-footer"><span>Jevable workflow runtime</span><span>Conversion review · not execution</span></footer>
  </div></MotionConfig>
}
createRoot(required('import-workspace-root')).render(<ImportReview />)
