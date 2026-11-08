// Build-input boundary guard shared by the build scripts.
//
// Every esbuild input must be a real file inside this checkout, under src/, ui/ or
// node_modules/, after symlinks are resolved. Inputs that escape the checkout, or that
// come from a Jarness/harness/desktop source tree, are refused, so a bundle cannot
// silently pick up code from outside this standalone core.
//
// This file was missing from the public repository, which stopped `npm run build`
// and `npm test` (via `pretest`). It was rebuilt from what its callers need. It is not
// a copy of the original private implementation, which may have been stricter.
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const allowedRoots = ['src', 'ui', 'node_modules']
const forbiddenSegment = /^(jarness|harness|jevable-desktop)$/i

export async function assertOwnedBuildInputs(root, inputs) {
  const realRoot = await realpath(root)
  const refused = []
  for (const input of inputs) {
    // esbuild namespaces such as "<define:...>" or "ns:path" are not files.
    if (input.startsWith('<') || /^[a-z][a-z0-9-]*:/i.test(input)) { refused.push(`${input} (non-file input)`); continue }
    if (isAbsolute(input)) { refused.push(`${input} (absolute path)`); continue }
    let real
    try { real = await realpath(resolve(root, input)) } catch { refused.push(`${input} (does not resolve)`); continue }
    const local = relative(realRoot, real)
    if (local.startsWith('..') || isAbsolute(local)) { refused.push(`${input} (outside the checkout)`); continue }
    const segments = local.split(sep)
    if (!allowedRoots.includes(segments[0])) { refused.push(`${input} (not under ${allowedRoots.join('/, ')}/)`); continue }
    if (segments.some(segment => forbiddenSegment.test(segment))) refused.push(`${input} (harness/desktop path)`)
  }
  if (refused.length) throw Error(`Build inputs outside the standalone boundary:\n  ${refused.join('\n  ')}`)
}
