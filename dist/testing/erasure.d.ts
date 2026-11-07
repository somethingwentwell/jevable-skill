import { z } from 'zod';
import type { WorkflowCompilerLimits } from '../workflow/index.ts';
export declare const TEST_ERASURE_POLICY_VERSION: "archived-draft-v1";
declare const reviewSchema: z.ZodObject<{
    test: z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
        sha256: z.ZodString;
    }, z.core.$strict>;
    reviewedHistorySha256: z.ZodString;
}, z.core.$strict>;
declare const referencesSchema: z.ZodObject<{
    runs: z.ZodNumber;
    generationBatches: z.ZodNumber;
    otherReferences: z.ZodNumber;
}, z.core.$strict>;
export declare const testErasurePreparationSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    policy: z.ZodLiteral<"archived-draft-v1">;
    test: z.ZodObject<{
        id: z.ZodUUID;
        generation: z.ZodNumber;
        sha256: z.ZodString;
    }, z.core.$strict>;
    historySha256: z.ZodString;
    projectId: z.ZodUUID;
    intrinsicReasons: z.ZodArray<z.ZodEnum<{
        "not-archived": "not-archived";
        "accepted-history": "accepted-history";
        "imported-history": "imported-history";
    }>>;
    eligibility: z.ZodLiteral<"not-assessed">;
    referenceFacts: z.ZodLiteral<"not-discovered">;
    authority: z.ZodLiteral<"none">;
    storageMutation: z.ZodLiteral<"not-performed">;
    scope: z.ZodLiteral<"archived-manual-never-accepted-draft">;
}, z.core.$strict>;
export type TestErasurePreparation = z.infer<typeof testErasurePreparationSchema>;
export type TestErasureReviewRequest = z.infer<typeof reviewSchema>;
/** Complete facts from a storage owner, not caller claims or a live-reference scan performed by this helper. */
export type TestErasureReferences = z.infer<typeof referencesSchema>;
export type TestErasureReason = 'not-archived' | 'accepted-history' | 'imported-history' | 'retained-runs' | 'generation-evidence' | 'other-retained-references';
export type TestErasureReview = {
    schemaVersion: 1;
    policy: typeof TEST_ERASURE_POLICY_VERSION;
    test: TestErasureReviewRequest['test'];
    historySha256: string;
    projectId: string;
    eligible: boolean;
    reasons: TestErasureReason[];
    references: TestErasureReferences;
    referenceFacts: 'supplied-not-discovered';
    authority: 'none';
    storageMutation: 'not-performed';
    scope: 'archived-manual-never-accepted-draft';
};
/** Hash the normalized, validated complete history—not just its latest definition or a file's formatting. */
export declare function testHistorySha256(value: unknown, limits?: WorkflowCompilerLimits, maxBytes?: number): string;
/** Prepare exact history pins only. No reference scan, eligibility assessment or authority. */
export declare function prepareTestErasureReview(value: unknown, limits?: WorkflowCompilerLimits, maxBytes?: number): TestErasurePreparation;
/**
 * Pure review foundation. No storage is opened, references discovered, authority granted or data erased.
 * A future write must recompute complete reference facts and this review within the owner's atomic
 * mutation boundary, preserve a metadata receipt/tombstone and never reuse the erased identity.
 */
export declare function reviewTestErasure(value: unknown, request: TestErasureReviewRequest, retained: TestErasureReferences, limits?: WorkflowCompilerLimits, maxBytes?: number): TestErasureReview;
export {};
