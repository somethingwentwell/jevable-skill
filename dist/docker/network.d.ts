import { z } from 'zod';
import type { DockerCommand } from '../images/docker.ts';
/** Select one existing local bridge by reviewed immutable ID, never by discovery or name alone. */
export declare const ownerNetworkSchema: z.ZodObject<{
    name: z.ZodString;
    id: z.ZodString;
}, z.core.$strict>;
export type OwnerNetwork = z.infer<typeof ownerNetworkSchema>;
export declare function verifyOwnerNetwork(context: string, network: OwnerNetwork, run: DockerCommand): Promise<boolean>;
/** Extra attachments and name-reused networks are not the reviewed execution environment. */
export declare function matchesOwnerNetwork(settings: unknown, network: OwnerNetwork): boolean;
