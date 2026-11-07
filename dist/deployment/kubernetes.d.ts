import { z } from 'zod';
import { type loadReleaseRuntime } from '../packages/release-zip.ts';
import { type ImageReceipt } from '../images/service.ts';
import type { Release } from '../releases/snapshot.ts';
export declare const kubernetesCommonOptionsSchema: z.ZodObject<{
    name: z.ZodString;
    namespace: z.ZodString;
    image: z.ZodString;
    publicOrigin: z.ZodString;
    configurationSecret: z.ZodString;
    imagePullSecrets: z.ZodDefault<z.ZodArray<z.ZodString>>;
    telemetry: z.ZodBoolean;
    telemetryExtraCa: z.ZodDefault<z.ZodBoolean>;
    telemetryPodMetadata: z.ZodDefault<z.ZodBoolean>;
    notifications: z.ZodOptional<z.ZodBoolean>;
    notificationsExtraCa: z.ZodOptional<z.ZodBoolean>;
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
}, z.core.$strict>;
export declare const kubernetesOptionsSchema: z.ZodObject<{
    name: z.ZodString;
    namespace: z.ZodString;
    image: z.ZodString;
    publicOrigin: z.ZodString;
    configurationSecret: z.ZodString;
    imagePullSecrets: z.ZodDefault<z.ZodArray<z.ZodString>>;
    telemetry: z.ZodBoolean;
    telemetryExtraCa: z.ZodDefault<z.ZodBoolean>;
    telemetryPodMetadata: z.ZodDefault<z.ZodBoolean>;
    notifications: z.ZodOptional<z.ZodBoolean>;
    notificationsExtraCa: z.ZodOptional<z.ZodBoolean>;
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
    imageBinding: z.ZodLiteral<"operator-verified-release-and-platform">;
}, z.core.$strict>;
export type KubernetesOptions = z.input<typeof kubernetesOptionsSchema>;
/** Pure local export: no registry, Docker, kubectl, database or network access. */
export declare function createKubernetesBundle(release: Release, artifact: Awaited<ReturnType<typeof loadReleaseRuntime>>, imageValue: ImageReceipt, input: KubernetesOptions): {
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
        rateCoordinator?: string;
        schemaVersion: number;
        format: string;
        releaseId: string;
        releaseSha256: string;
        revision: string;
        runtime: {
            version: string;
            sha256: string;
        };
        image: string;
        platform: "linux/arm64" | "linux/amd64";
        storage: string;
        mode: string;
    };
};
