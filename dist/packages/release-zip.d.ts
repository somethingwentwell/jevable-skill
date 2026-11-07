import { readBoundedBytes } from '../files.ts';
import { type Release } from '../releases/snapshot.ts';
import { type EvidenceAttachmentInput } from '../evidence/attachment.ts';
import { z } from 'zod';
export interface ReleaseRuntimeArtifact {
    bytes: Buffer;
    notices: Buffer;
    storage: 'sqlite' | 'postgres';
    rateCoordinator?: 'postgres';
    identity: {
        version: string;
        sha256: string;
    };
}
declare const coordinatedProfile: z.ZodObject<{
    storage: z.ZodLiteral<"sqlite">;
    rateCoordinator: z.ZodLiteral<"postgres">;
}, z.core.$strict>;
export type CoordinatedReleaseRuntimeProfile = z.infer<typeof coordinatedProfile>;
/** Default profiles preserve SQLite's no-PostgreSQL-driver bundle. */
export declare function loadReleaseRuntime(storage?: 'sqlite' | 'postgres', readBytes?: typeof readBoundedBytes): Promise<ReleaseRuntimeArtifact>;
/** Explicit optional SQLite workflow bundle with PostgreSQL HTTP quotas, never workflow storage. */
export declare function loadReleaseRuntimeProfile(profile: CoordinatedReleaseRuntimeProfile, readBytes?: typeof readBoundedBytes): Promise<ReleaseRuntimeArtifact>;
/** Select the exact saved runtime identity; exporting never rewrites a release to another backend. */
export declare function loadReleaseRuntimeForIdentity(identity: Release['snapshot']['runtime']): Promise<ReleaseRuntimeArtifact>;
/** Fixed allowlist assembled from a saved release plus this distribution's exact prebuilt runtime. */
export declare function createReleaseFiles(value: Release, artifact: Awaited<ReturnType<typeof loadReleaseRuntime>>): Record<string, Uint8Array>;
export declare function createReleaseZip(value: Release, artifact: Awaited<ReturnType<typeof loadReleaseRuntime>>): Buffer;
/** Explicit review material; never a runtime database, approval grant, or release execution attestation. */
export declare function createReleaseZipWithEvidence(value: Release, artifact: Awaited<ReturnType<typeof loadReleaseRuntime>>, input: EvidenceAttachmentInput): Promise<{
    bytes: Buffer<ArrayBuffer>;
    evidence: {
        format: "jevable.ai/evidence-attachment";
        path: "evidence.zip";
        sha256: string;
        bytes: number;
        selectionSha256: string;
        revision: string;
        declaredPrivacy: "metadata-only" | "private-execution-data";
        runs: number;
        relationship: "workflow-revision-only";
        authenticity: "not-verified";
        restoration: "unsupported";
    };
    inspection: {
        schemaVersion: number;
        status: string;
        format: "jevable.ai/evidence-zip";
        artifact: {
            sha256: string;
            bytes: number;
        };
        expectedChecksum: string;
        selectionSha256: string;
        declaredPrivacy: "metadata-only" | "private-execution-data";
        privatePayloads: string;
        runs: {
            test?: {
                id: string;
                generation: number;
                sha256: string;
            };
            assessment?: "failed" | "pending" | "uncertain" | "passed";
            terminal?: boolean;
            checks?: {
                total: number;
                matched: number;
                available: number;
            };
            evidenceVersion: 1 | 2;
            snapshotSha256: string;
            triggerMode?: import("../runtime/trigger.ts").ApiTriggerMode;
            id: string;
            revision: string;
            workflowStatus: "cancelled" | "completed" | "paused" | "failed" | "waiting" | "executing";
            observedRunUpdatedAt: string;
        }[];
        files: number;
        consistency: "per-run-observations; not-an-atomic-snapshot";
        authenticity: string;
        runtimeHistoryReplay: string;
        privacyAttestation: string;
        execution: string;
        restoration: string;
    };
}>;
export {};
