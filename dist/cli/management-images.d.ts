import { type CliValues } from './runtime.ts';
/** Program packaging is independent of any runtime owner, storage backend, credential or service. */
export declare function managementImageFromCli(action: 'build-image' | 'save-image' | 'export-kubernetes', values: CliValues, receiptPath?: string): Promise<{
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
} | {
    artifact: {
        path: string;
        bytes: number;
        sha256: string;
    };
    imageBinding: string;
    publication: string;
    execution: string;
    clusterQualification: string;
    files: {
        path: string;
        bytes: number;
        sha256: string;
    }[];
    reviewerDecisions?: boolean;
    rateCoordinator?: string;
    schemaVersion: number;
    format: string;
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
    programManifestSha256: string;
    image: string;
    platform: "linux/arm64" | "linux/amd64";
    storage: string;
    mode: string;
    status: string;
    receipt?: never;
} | {
    status: string;
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
    receipt: {
        path: string;
        bytes: number;
        sha256: string;
    };
}>;
