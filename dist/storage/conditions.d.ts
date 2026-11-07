import { z } from 'zod';
export declare const journalConditionsSchema: z.ZodObject<{
    records: z.ZodArray<z.ZodObject<{
        collection: z.ZodEnum<{
            runs: "runs";
            releases: "releases";
            "access-grants": "access-grants";
        }>;
        key: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
        version: z.ZodString;
        sha256: z.ZodString;
    }, z.core.$strict>>;
    notBefore: z.ZodISODateTime;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>;
export type JournalConditions = z.infer<typeof journalConditionsSchema>;
/** Snapshot pin, not a signature or substitute for domain-history validation. */
export declare const journalConditionHash: (value: unknown) => string;
export declare function parseJournalConditions(value: unknown): JournalConditions;
/** A synchronous final time check after queued snapshot reads and before the first write. */
export declare function checkJournalConditionTime(conditions: JournalConditions, at?: string): void;
