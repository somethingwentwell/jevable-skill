import { z } from 'zod'
import type { DockerCommand } from '../images/docker.ts'

/** Select one existing local bridge by reviewed immutable ID, never by discovery or name alone. */
export const ownerNetworkSchema = z.strictObject({
  name: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u)
    .refine(name => !['bridge', 'host', 'none', 'ingress'].includes(name)),
  id: z.string().regex(/^[a-f0-9]{64}$/u),
})
export type OwnerNetwork = z.infer<typeof ownerNetworkSchema>

export async function verifyOwnerNetwork(context: string, network: OwnerNetwork, run: DockerCommand): Promise<boolean> {
  const raw = await run(['--context', context, 'network', 'inspect', network.id])
  let rows: unknown
  try { rows = JSON.parse(raw) } catch { return false }
  if (!Array.isArray(rows) || rows.length !== 1) return false
  const n = rows[0]
  return n?.Id === network.id && n.Name === network.name && n.Driver === 'bridge' && n.Scope === 'local'
    && n.Ingress === false && typeof n.Internal === 'boolean'
}

/** Extra attachments and name-reused networks are not the reviewed execution environment. */
export function matchesOwnerNetwork(settings: unknown, network: OwnerNetwork): boolean {
  const parsed = z.object({ Networks: z.record(z.string(), z.object({ NetworkID: z.string() })) }).safeParse(settings)
  if (!parsed.success) return false
  const entries = Object.entries(parsed.data.Networks)
  return entries.length === 1 && entries[0]![0] === network.name && entries[0]![1].NetworkID === network.id
}
