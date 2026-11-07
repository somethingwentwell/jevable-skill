'use client';

/**
 * Adapted from Animate UI's primitives-animate-tabs registry component.
 * https://animate-ui.com/r/primitives-animate-tabs.json (2026-10-07)
 * Copyright (c) 2025 Elliot Sutton. MIT + Commons Clause; see notices/animate-ui.txt.
 * Keeps the upstream controlled context and Motion trigger. Removes unused slot,
 * blur/auto-height and highlight dependencies; adds roving focus and ARIA linkage.
 * Panels stay mounted: hiding a tab must never destroy a runtime control or its identity.
 */
import * as React from 'react'
import { motion, useReducedMotion } from 'motion/react'

const Context = React.createContext<{ value: string; change: (value: string) => void; id: string } | null>(null)
export function Tabs({ value, onValueChange, children, ...props }: React.ComponentProps<'div'> & {
  value: string; onValueChange: (value: string) => void
}) {
  const id = React.useId()
  return <Context.Provider value={{ value, change: onValueChange, id }}><div data-slot="tabs" {...props}>{children}</div></Context.Provider>
}
export function TabsList(props: React.ComponentProps<'div'>) {
  return <div role="tablist" data-slot="tabs-list" {...props} onKeyDown={event => {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]'))
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : event.key === 'ArrowRight' ? (index + 1) % buttons.length
        : event.key === 'ArrowLeft' ? (index + buttons.length - 1) % buttons.length : -1
    if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); buttons[next]?.click() }
  }} />
}
export function TabsTrigger({ value, children }: { value: string; children: React.ReactNode }) {
  const context = React.useContext(Context)!
  const selected = context.value === value
  return <motion.button type="button" role="tab" id={`tab-${value}`} aria-controls={`panel-${value}`}
    aria-selected={selected} tabIndex={selected ? 0 : -1} data-state={selected ? 'active' : 'inactive'}
    data-slot="tabs-trigger" onClick={() => context.change(value)} whileTap={{ scale: 0.98 }}>
    {selected && <motion.span aria-hidden className="tab-highlight" layoutId={`selected-${context.id}`} transition={{ type: 'spring', stiffness: 200, damping: 25 }} />}{children}
  </motion.button>
}
export function TabsContent({ value, children }: { value: string; children: React.ReactNode }) {
  const context = React.useContext(Context)!
  const reduce = useReducedMotion()
  return <motion.div role="tabpanel" id={`panel-${value}`} aria-labelledby={`tab-${value}`}
    initial={false} animate={{ opacity: context.value === value ? 1 : 0 }} transition={{ duration: reduce ? 0 : 0.16 }}
    hidden={context.value !== value} data-slot="tabs-content">{children}</motion.div>
}
