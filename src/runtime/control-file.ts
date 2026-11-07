import { readBoundedFile } from '../files.ts'
import { breakpointListSchema } from './control.ts'
import { WorkflowRuntimeError } from './errors.ts'

/** Admit explicit CLI configuration before acquiring any runtime/storage owner. */
export async function readBreakpointFile(path: string | boolean | undefined): Promise<string[] | undefined> {
  if (path === undefined) return undefined
  if (typeof path !== 'string') throw new WorkflowRuntimeError('invalid-command')
  const contents = await readBoundedFile(path, 100_000)
  try { return breakpointListSchema.parse(JSON.parse(contents)) }
  catch { throw new WorkflowRuntimeError('invalid-command') }
}
