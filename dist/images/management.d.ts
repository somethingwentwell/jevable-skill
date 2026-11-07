import { z } from 'zod';
import { readBoundedBytes } from '../files.ts';
import { type ImageBuildOptions } from './local.ts';
import { type DockerCommand } from './docker.ts';
export declare const managementImageReceiptSchema: z.ZodObject<{
    coreVersion: z.ZodString;
    runtimes: z.ZodTuple<[z.ZodObject<{
        role: z.ZodLiteral<"management">;
        sha256: z.ZodString;
        bytes: z.ZodNumber;
    }, z.core.$strict>, z.ZodObject<{
        role: z.ZodLiteral<"sqlite">;
        sha256: z.ZodString;
        bytes: z.ZodNumber;
    }, z.core.$strict>, z.ZodObject<{
        role: z.ZodLiteral<"postgres">;
        sha256: z.ZodString;
        bytes: z.ZodNumber;
    }, z.core.$strict>], null>;
    manifestSha256: z.ZodString;
    recipeSha256: z.ZodString;
    state: z.ZodLiteral<"excluded">;
    credentials: z.ZodLiteral<"excluded">;
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
    format: z.ZodLiteral<"jevable.ai/management-image-receipt">;
}, z.core.$strict>;
export type ManagementImageReceipt = z.infer<typeof managementImageReceiptSchema>;
/** Read-only validation shared with the explicit lifecycle owner; never accept a release-only image. */
export declare function verifyManagementImage(image: unknown, receipt: ManagementImageReceipt): void;
/** Packages this reviewed management program only; never opens state, starts containers or discovers a daemon. */
export declare function buildManagementImage(expectedRuntimeSha256: string, input: ImageBuildOptions, run?: DockerCommand, readBytes?: typeof readBoundedBytes): Promise<ManagementImageReceipt>;
export declare function inspectManagementImageReceipt(value: unknown): ManagementImageReceipt;
export declare function saveManagementImage(value: ManagementImageReceipt, path: string, overwrite?: boolean, run?: DockerCommand): Promise<{
    format: string;
    image: {
        coreVersion: string;
        runtimes: [{
            role: "management";
            sha256: string;
            bytes: number;
        }, {
            role: "sqlite";
            sha256: string;
            bytes: number;
        }, {
            role: "postgres";
            sha256: string;
            bytes: number;
        }];
        manifestSha256: string;
        recipeSha256: string;
        state: "excluded";
        credentials: "excluded";
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
        format: "jevable.ai/management-image-receipt";
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
