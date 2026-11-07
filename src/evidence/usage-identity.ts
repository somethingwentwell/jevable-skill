import { z } from 'zod'

/** Explicit usage-only projection of the verified requested identity, never endpoint/credentials/response IDs. */
export const USAGE_IDENTITY_FORMAT = 'requested-provider-model/v1' as const
const name = z.string().min(1).max(256).refine(value => value.trim() === value)
export const usageIdentitySchema = z.strictObject({ provider: name, model: name })
export type UsageIdentity = z.infer<typeof usageIdentitySchema>
