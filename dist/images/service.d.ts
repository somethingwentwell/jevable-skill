import { z } from 'zod';
import { type loadReleaseRuntime } from '../packages/release-zip.ts';
import type { Release } from '../releases/snapshot.ts';
import { type DockerCommand } from './docker.ts';
import { type ImageBuildOptions } from './local.ts';
export type { ImageBuildOptions } from './local.ts';
export declare const imageReceiptSchema: z.ZodObject<{
    releaseId: z.ZodUUID;
    releaseSha256: z.ZodString;
    revision: z.ZodString;
    runtime: z.ZodObject<{
        version: z.ZodString;
        sha256: z.ZodString;
    }, z.core.$strict>;
    manifestSha256: z.ZodString;
    createdAt: z.ZodISODateTime;
    context: z.ZodString;
    platform: z.ZodEnum<{
        "linux/arm64": "linux/arm64";
        "linux/amd64": "linux/amd64";
    }>;
    baseImage: z.ZodString;
    tag: z.ZodString;
    imageId: z.ZodString;
    engineVersion: z.ZodString;
    execution: z.ZodLiteral<"not-run">;
    publication: z.ZodLiteral<"local-daemon-only">;
    schemaVersion: z.ZodLiteral<1>;
    format: z.ZodLiteral<"jevable.ai/image-receipt">;
}, z.core.$strict>;
export type ImageReceipt = z.infer<typeof imageReceiptSchema>;
/** Build only owned files into an explicit local Docker engine. Never pushes, runs workflows or replaces tags. */
export declare function buildReleaseImage(release: Release, artifact: Awaited<ReturnType<typeof loadReleaseRuntime>>, input: ImageBuildOptions, run?: DockerCommand): Promise<ImageReceipt>;
/** Stream an immutable image ID, not a mutable tag, into an atomically published Docker-loadable archive. */
export declare function saveReleaseImage(value: ImageReceipt, path: string, overwrite?: boolean, run?: DockerCommand): Promise<{
    format: string;
    image: {
        releaseId: string;
        releaseSha256: string;
        revision: string;
        runtime: {
            version: string;
            sha256: string;
        };
        manifestSha256: string;
        createdAt: string;
        context: string;
        platform: "linux/arm64" | "linux/amd64";
        baseImage: string;
        tag: string;
        imageId: string;
        engineVersion: string;
        execution: "not-run";
        publication: "local-daemon-only";
        schemaVersion: 1;
        format: "jevable.ai/image-receipt";
    };
    schemaVersion: number;
    artifact: {
        path: string;
        bytes: number;
        sha256: string;
    };
    archive: string;
    tagging: string;
    execution: string;
    publication: string;
}>;
export declare function inspectImageReceipt(value: unknown): ImageReceipt;
