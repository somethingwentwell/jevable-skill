import { z } from 'zod';
import { readBoundedBytes } from '../files.ts';
import { type ManagementImageReceipt } from '../images/management.ts';
/** A distinct management profile; release receipts and release assertions never substitute. */
export declare const managementKubernetesOptionsSchema: z.ZodObject<{
    name: z.ZodString;
    namespace: z.ZodString;
    image: z.ZodString;
    publicOrigin: z.ZodString;
    configurationSecret: z.ZodString;
    imagePullSecrets: z.ZodDefault<z.ZodArray<z.ZodString>>;
    telemetry: z.ZodBoolean;
    telemetryExtraCa: z.ZodDefault<z.ZodBoolean>;
    telemetryPodMetadata: z.ZodDefault<z.ZodBoolean>;
    rateCoordinator: z.ZodOptional<z.ZodBoolean>;
    databaseTransportWaitSeconds: z.ZodDefault<z.ZodNumber>;
    terminationGracePeriodSeconds: z.ZodNumber;
    resources: z.ZodObject<{
        requestCpuMillis: z.ZodNumber;
        limitCpuMillis: z.ZodNumber;
        requestMemoryMiB: z.ZodNumber;
        limitMemoryMiB: z.ZodNumber;
    }, z.core.$strict>;
    network: z.ZodObject<{
        dns: z.ZodObject<{
            kind: z.ZodLiteral<"pods">;
            namespace: z.ZodString;
            labels: z.ZodRecord<z.ZodString, z.ZodString>;
        }, z.core.$strict>;
        ingress: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"pods">;
            namespace: z.ZodString;
            labels: z.ZodRecord<z.ZodString, z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"cidr">;
            cidr: z.ZodString;
        }, z.core.$strict>], "kind">>;
        egress: z.ZodArray<z.ZodObject<{
            peer: z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"pods">;
                namespace: z.ZodString;
                labels: z.ZodRecord<z.ZodString, z.ZodString>;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"cidr">;
                cidr: z.ZodString;
            }, z.core.$strict>], "kind">;
            port: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    imageBinding: z.ZodLiteral<"operator-verified-management-and-platform">;
    storage: z.ZodLiteral<"postgres">;
    notifications: z.ZodOptional<z.ZodLiteral<false>>;
    notificationsExtraCa: z.ZodOptional<z.ZodLiteral<false>>;
    reviewerDecisions: z.ZodOptional<z.ZodBoolean>;
    asyncConcurrency: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export type ManagementKubernetesOptions = z.input<typeof managementKubernetesOptionsSchema>;
/** Readiness verifies the fixed program files, authenticated TLS and management database health. */
export declare function managementReadinessProbe(files: {
    path: string;
    bytes: number;
    sha256: string;
}[]): string;
/** Local artifact reads only. Never contacts a registry, Docker, database or cluster. */
export declare function createManagementKubernetesBundle(imageValue: ManagementImageReceipt, input: ManagementKubernetesOptions, readBytes?: typeof readBoundedBytes): Promise<{
    bytes: Uint8Array<ArrayBuffer>;
    manifest: {
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
    };
}>;
