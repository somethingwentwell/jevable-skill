import { z } from 'zod';
export declare const recordPageSchema: z.ZodObject<{
    after: z.ZodOptional<z.ZodUUID>;
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export declare const auditPageSchema: z.ZodObject<{
    after: z.ZodOptional<z.ZodString>;
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
/** Legacy SQLite lists keep their existing order. Explicit pages use immutable identity keysets. */
export declare function recordPage<T extends {
    id: string;
}>(rows: T[], after: string | undefined, limit: number): {
    items: T[];
    nextCursor: string | null;
};
export declare function auditPage(rows: unknown[], after: string | undefined, limit: number): {
    events: (object & Record<"sequence", unknown>)[];
    cursor: string;
};
