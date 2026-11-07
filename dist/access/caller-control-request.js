import { grantIdSchema } from "./grants.js";
import { executionControlSchema } from "../runtime/control.js";
/** Shared strict input, separate from retained receipt projections to avoid a caller-schema cycle. */
export const callerControlRequestSchema = executionControlSchema.extend({ requestId: grantIdSchema });
