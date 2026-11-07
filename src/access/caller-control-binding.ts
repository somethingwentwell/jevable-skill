import { z } from 'zod'
import { grantIdSchema, grantScopeSchema } from './grants.ts'

/** Private retained attribution, never public control input or a live authorization token. */
export const callerControlBindingSchema = z.strictObject({ grantId: grantIdSchema,
  scope: grantScopeSchema.options[0], deadline: z.iso.datetime() })
  .refine(value => value.scope.permissions.includes('control'))
