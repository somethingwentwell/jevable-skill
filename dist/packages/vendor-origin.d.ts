import { z } from 'zod';
export declare const VENDOR_ORIGIN_LIMITS: Readonly<{
    archiveBytes: 32000000;
    entryBytes: 16000000;
    totalBytes: 48000000;
    entries: 6;
}>;
declare const optionsSchema: z.ZodObject<{
    projectId: z.ZodPipe<z.ZodUUID, z.ZodTransform<string, string>>;
    reviewedOriginSha256: z.ZodString;
    includePrivate: z.ZodLiteral<true>;
}, z.core.$strict>;
export type VendorOriginExportOptions = z.input<typeof optionsSchema>;
export declare class VendorOriginPackageError extends Error {
    readonly code: 'invalid-command' | 'invalid-package' | 'package-limit' | 'checksum-mismatch' | 'conflict';
    constructor(code: 'invalid-command' | 'invalid-package' | 'package-limit' | 'checksum-mismatch' | 'conflict');
}
/** Consume a separately authorized private owner view and its reviewed immutable origin hash. */
export declare function createVendorOriginZip(value: unknown, options: VendorOriginExportOptions): {
    bytes: Buffer<ArrayBuffer>;
    manifest: {
        format: "jevable.ai/vendor-origin-evidence-zip";
        version: 1;
        projectId: string;
        revision: string;
        originSha256: string;
        sourceSha256: string;
        conversionSha256: string;
        privatePayloads: "included";
        authenticity: "checksums-only; not-signed";
        restoration: "not-supported";
        execution: "not-run";
        files: {
            path: "README.txt" | "origin.json" | "source.txt" | "conversion.yaml" | "conversion-report.json";
            bytes: number;
            sha256: string;
        }[];
    };
};
/** Bounded in-memory verification; returns metadata only, never extracts or exposes source/attribution. */
export declare function inspectVendorOriginZip(input: Uint8Array, reviewedSha256?: string): Promise<{
    schemaVersion: 1;
    status: "consistent";
    format: "jevable.ai/vendor-origin-evidence-zip";
    artifactSha256: string;
    projectId: string;
    revision: string;
    originSha256: string;
    sourceSha256: string;
    conversionSha256: string;
    conversionRevision: string;
    converter: {
        name: "jevable-owned";
        version: string;
    };
    vendorFormat: "n8n" | "dify" | "coze" | "zapier" | "make" | "power-automate";
    mappingCounts: {
        exact: number;
        approximate: number;
        unsupported: number;
    };
    files: {
        path: "README.txt" | "origin.json" | "source.txt" | "conversion.yaml" | "conversion-report.json";
        bytes: number;
        sha256: string;
    }[];
    privatePayloads: "included-but-not-displayed";
    authenticity: "checksums-only; not-signed";
    restoration: "not-supported";
    execution: "not-run";
}>;
export {};
