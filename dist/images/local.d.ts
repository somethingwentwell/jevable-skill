import { z } from 'zod';
import { type DockerCommand } from './docker.ts';
export declare const hashSchema: z.ZodString;
export declare const buildSchema: z.ZodObject<{
    context: z.ZodString;
    platform: z.ZodEnum<{
        "linux/arm64": "linux/arm64";
        "linux/amd64": "linux/amd64";
    }>;
    baseImage: z.ZodString;
    tag: z.ZodString;
}, z.core.$strict>;
export type ImageBuildOptions = z.infer<typeof buildSchema>;
export declare const imageIdentityFields: {
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
};
export declare function parsed<T>(schema: z.ZodType<T>, value: unknown): T;
export declare function localEngine(context: string, run: DockerCommand): Promise<string>;
export declare function inspect(context: string, reference: string, run: DockerCommand): Promise<any>;
/** Internal shared packaging transport. Callers supply owned program files and role-specific image verification. */
export declare function buildLocalImage(options: ImageBuildOptions, files: Record<string, Uint8Array>, labels: Record<string, string>, verify: (image: any, id: string) => void, run: DockerCommand): Promise<{
    imageId: string;
    engineVersion: string;
    createdAt: string;
    execution: "not-run";
    publication: "local-daemon-only";
    context: string;
    platform: "linux/arm64" | "linux/amd64";
    baseImage: string;
    tag: string;
}>;
/** Save immutable identity with pre/post verification; retain daemon state on uncertain failure. */
export declare function saveLocalImage(receipt: {
    context: string;
    imageId: string;
}, path: string, overwrite: boolean, verify: (image: any) => void, run: DockerCommand): Promise<{
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
