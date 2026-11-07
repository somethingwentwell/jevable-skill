import { readBoundedFile } from "../files.js";
import { breakpointListSchema } from "./control.js";
import { WorkflowRuntimeError } from "./errors.js";
/** Admit explicit CLI configuration before acquiring any runtime/storage owner. */
export async function readBreakpointFile(path) {
    if (path === undefined)
        return undefined;
    if (typeof path !== 'string')
        throw new WorkflowRuntimeError('invalid-command');
    const contents = await readBoundedFile(path, 100_000);
    try {
        return breakpointListSchema.parse(JSON.parse(contents));
    }
    catch {
        throw new WorkflowRuntimeError('invalid-command');
    }
}
