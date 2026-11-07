import { readBoundedBytes } from '../files.ts';
import { z } from 'zod';
export declare const MANAGEMENT_PACKAGE_FILES: readonly string[];
export declare const MANAGEMENT_COORDINATED_PACKAGE_FILES: readonly string[];
declare const archiveOptions: z.ZodObject<{
    rateCoordinator: z.ZodOptional<z.ZodLiteral<"postgres">>;
}, z.core.$strict>;
export type RuntimeArchiveOptions = z.infer<typeof archiveOptions>;
/** Fixed shipped assets only: never enumerate the working directory or open runtime state. */
export declare function createManagementFiles(readBytes?: typeof readBoundedBytes, options?: RuntimeArchiveOptions): Promise<{
    files: Record<string, Uint8Array<ArrayBufferLike>>;
    manifest: {
        format: string;
        version: string;
        entrypoint: string;
        requires: {
            node: string;
            sqlite: string;
            npmInstall: boolean;
            docker: boolean;
        };
        runtimes: {
            role: string;
            sha256: string;
            bytes: number;
        }[];
        files: {
            path: string;
            bytes: number;
            sha256: string;
        }[];
        state: string;
        credentials: string;
        authenticity: string;
        execution: string;
        schemaVersion: 2;
        rateCoordinator: "postgres";
    } | {
        format: string;
        version: string;
        entrypoint: string;
        requires: {
            node: string;
            sqlite: string;
            npmInstall: boolean;
            docker: boolean;
        };
        runtimes: {
            role: string;
            sha256: string;
            bytes: number;
        }[];
        files: {
            path: string;
            bytes: number;
            sha256: string;
        }[];
        state: string;
        credentials: string;
        authenticity: string;
        execution: string;
        schemaVersion: 1;
    };
}>;
export declare function createManagementZip(readBytes?: typeof readBoundedBytes, options?: RuntimeArchiveOptions): Promise<{
    bytes: Buffer<ArrayBuffer>;
    manifest: {
        format: string;
        version: string;
        entrypoint: string;
        requires: {
            node: string;
            sqlite: string;
            npmInstall: boolean;
            docker: boolean;
        };
        runtimes: {
            role: string;
            sha256: string;
            bytes: number;
        }[];
        files: {
            path: string;
            bytes: number;
            sha256: string;
        }[];
        state: string;
        credentials: string;
        authenticity: string;
        execution: string;
        schemaVersion: 2;
        rateCoordinator: "postgres";
    } | {
        format: string;
        version: string;
        entrypoint: string;
        requires: {
            node: string;
            sqlite: string;
            npmInstall: boolean;
            docker: boolean;
        };
        runtimes: {
            role: string;
            sha256: string;
            bytes: number;
        }[];
        files: {
            path: string;
            bytes: number;
            sha256: string;
        }[];
        state: string;
        credentials: string;
        authenticity: string;
        execution: string;
        schemaVersion: 1;
    };
}>;
export {};
