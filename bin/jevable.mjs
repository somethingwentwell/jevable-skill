#!/usr/bin/env node
let main
try {
  ({ main } = await import('../dist/cli.js'))
} catch (error) {
  // A git checkout ships prebuilt dist/ but not node_modules/. Explain the fix instead of a stack trace.
  if (error?.code !== 'ERR_MODULE_NOT_FOUND' || String(error.url ?? '').includes('/dist/')) throw error
  const root = new URL('..', import.meta.url).pathname
  process.stderr.write(`jevable: a runtime dependency is missing (${error.message.split('\n')[0]}).\n`
    + `Install the runtime dependencies once from the checkout root, then retry:\n  cd ${root}\n  npm ci --omit=dev\n`)
  process.exit(1)
}
process.exitCode = await main(process.argv.slice(2))
