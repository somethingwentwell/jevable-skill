import { z } from 'zod';
import type { TestRecord } from './ledger.ts';
export declare const testErasureRequestSchema: z.ZodObject<{
    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    test: z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
        sha256: z.ZodString;
    }, z.core.$strict>;
    reviewedHistorySha256: z.ZodString;
    actor: z.ZodString;
}, z.core.$strict>;
export type TestErasureRequest = z.infer<typeof testErasureRequestSchema>;
/** CLI request-file and owner HTTP input: attribution is assigned by the selected host. */
export declare const testErasureCommandSchema: z.ZodObject<{
    requestId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    test: z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
        sha256: z.ZodString;
    }, z.core.$strict>;
    reviewedHistorySha256: z.ZodString;
}, z.core.$strict>;
export type TestErasureCommand = z.infer<typeof testErasureCommandSchema>;
export declare const testErasureReceiptSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    policy: z.ZodLiteral<"archived-draft-v1">;
    requestId: z.ZodUUID;
    test: z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
        sha256: z.ZodString;
    }, z.core.$strict>;
    historySha256: z.ZodString;
    project: z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
        revision: z.ZodString;
    }, z.core.$strict>;
    actor: z.ZodString;
    at: z.ZodISODateTime;
    status: z.ZodLiteral<"logically-removed">;
    securePhysicalErasure: z.ZodLiteral<false>;
}, z.core.$strict>;
export type TestErasureReceipt = z.infer<typeof testErasureReceiptSchema>;
export declare const savedTestErasureSchema: z.ZodObject<{
    format: z.ZodLiteral<"jevable.test-erasure/v1">;
    receipt: z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        policy: z.ZodLiteral<"archived-draft-v1">;
        requestId: z.ZodUUID;
        test: z.ZodObject<{
            id: z.ZodUUID;
            generation: z.ZodNumber;
            sha256: z.ZodString;
        }, z.core.$strict>;
        historySha256: z.ZodString;
        project: z.ZodObject<{
            id: z.ZodUUID;
            generation: z.ZodNumber;
            revision: z.ZodString;
        }, z.core.$strict>;
        actor: z.ZodString;
        at: z.ZodISODateTime;
        status: z.ZodLiteral<"logically-removed">;
        securePhysicalErasure: z.ZodLiteral<false>;
    }, z.core.$strict>;
    sha256: z.ZodString;
}, z.core.$strict>;
export declare const testErasureReceiptHash: (receipt: TestErasureReceipt) => string;
/** Internal preparation only after an owner atomically validates full history and live reference facts. */
export declare function prepareTestErasureReceipt(command: TestErasureRequest, record: TestRecord): TestErasureReceipt;
/** Exact retries observe a retained receipt; never refresh guards, mint identity or remove anything again. */
export declare function verifyTestErasureRetry(receipt: TestErasureReceipt, command: TestErasureRequest): void;
