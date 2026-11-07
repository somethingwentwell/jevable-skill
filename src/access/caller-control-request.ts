import { z } from 'zod'
import { grantIdSchema } from './grants.ts'
import { executionControlSchema } from '../runtime/control.ts'

/** Shared strict input, separate from retained receipt projections to avoid a caller-schema cycle. */
export const callerControlRequestSchema = executionControlSchema.extend({ requestId: grantIdSchema })
export type CallerControlRequest = z.input<typeof callerControlRequestSchema>
