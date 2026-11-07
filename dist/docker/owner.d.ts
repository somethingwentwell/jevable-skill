import { z } from 'zod';
import { writeArtifact } from '../files.ts';
import { RuntimeClient } from '../http/client.ts';
import { type DockerCommand } from '../images/docker.ts';
export declare class DockerLifecycleError extends Error {
    readonly code: 'invalid-options' | 'resource-conflict' | 'state-mismatch' | 'not-found' | 'not-cleanly-stopped' | 'startup-uncertain' | 'observation-unavailable';
    owner?: Awaited<ReturnType<typeof writeArtifact>>;
    constructor(code: 'invalid-options' | 'resource-conflict' | 'state-mismatch' | 'not-found' | 'not-cleanly-stopped' | 'startup-uncertain' | 'observation-unavailable');
}
declare const ownerSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    format: z.ZodLiteral<"jevable.ai/docker-owner">;
    id: z.ZodUUID;
    createdAt: z.ZodISODateTime;
    runtime: z.ZodLiteral<"docker">;
    storage: z.ZodEnum<{
        sqlite: "sqlite";
        postgres: "postgres";
    }>;
    image: z.ZodObject<{
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
    database: z.ZodOptional<z.ZodObject<{
        sha256: z.ZodString;
    }, z.core.$strict>>;
    rateLimits: z.ZodOptional<z.ZodObject<{
        sha256: z.ZodString;
    }, z.core.$strict>>;
    rateCoordinator: z.ZodOptional<z.ZodObject<{
        sha256: z.ZodString;
        scope: z.ZodUUID;
        policySha256: z.ZodString;
        timeoutMs: z.ZodNumber;
    }, z.core.$strict>>;
    asyncRuns: z.ZodOptional<z.ZodObject<{
        maxConcurrentRuns: z.ZodNumber;
    }, z.core.$strict>>;
    hostPort: z.ZodNumber;
    certificateSha256: z.ZodString;
    telemetry: z.ZodOptional<z.ZodObject<{
        sha256: z.ZodString;
        credentialRef: z.ZodOptional<z.ZodString>;
        caSha256: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    notifications: z.ZodOptional<z.ZodObject<{
        sha256: z.ZodString;
        caSha256: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    network: z.ZodOptional<z.ZodObject<{
        name: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>>;
    memoryMb: z.ZodNumber;
    cpus: z.ZodNumber;
}, z.core.$strict>;
export type DockerOwner = z.infer<typeof ownerSchema>;
declare const clientSchema: z.ZodObject<{
    tokenFile: z.ZodString;
    caFile: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type DockerOwnerClient = z.infer<typeof clientSchema>;
declare const startSchema: z.ZodObject<{
    image: z.ZodObject<{
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
    ownerFile: z.ZodString;
    hostPort: z.ZodNumber;
    storage: z.ZodDefault<z.ZodEnum<{
        sqlite: "sqlite";
        postgres: "postgres";
    }>>;
    databaseFile: z.ZodOptional<z.ZodString>;
    tokenFile: z.ZodString;
    certificateFile: z.ZodString;
    privateKeyFile: z.ZodString;
    caFile: z.ZodOptional<z.ZodString>;
    telemetryFile: z.ZodOptional<z.ZodString>;
    telemetryCredentialFile: z.ZodOptional<z.ZodString>;
    telemetryCaFile: z.ZodOptional<z.ZodString>;
    notificationsFile: z.ZodOptional<z.ZodString>;
    notificationsCaFile: z.ZodOptional<z.ZodString>;
    rateLimitsFile: z.ZodOptional<z.ZodString>;
    rateCoordinatorFile: z.ZodOptional<z.ZodString>;
    asyncRuns: z.ZodOptional<z.ZodObject<{
        maxConcurrentRuns: z.ZodNumber;
    }, z.core.$strict>>;
    network: z.ZodOptional<z.ZodObject<{
        name: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>>;
    memoryMb: z.ZodDefault<z.ZodNumber>;
    cpus: z.ZodDefault<z.ZodNumber>;
    waitMs: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export type StartDockerOwnerOptions = z.input<typeof startSchema>;
export declare function dockerOwnerResources(value: DockerOwner): {
    container: string;
    initializer: string;
    stateVolume: string | undefined;
    configVolume: string;
    endpoint: string;
};
export declare function readDockerOwner(file: string, reviewedSha256: string): Promise<DockerOwner>;
type Client = Pick<RuntimeClient, 'capabilities' | 'health'>;
export interface DockerOwnerDependencies {
    run?: DockerCommand;
    client?: (endpoint: string, token: string, ca: string | undefined) => Client;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}
/** Read-only owner observation; no repair, discovery, automatic start or workflow replay. */
export declare function inspectDockerOwner(value: DockerOwner, clientOptions?: DockerOwnerClient, dependencies?: DockerOwnerDependencies): Promise<{
    service: {
        activeAsyncRuns?: number;
        status: "closed" | "ready" | "draining";
        instanceId: string;
        activeRequests: number;
    } | {
        retryAfterSeconds?: number;
        status: "unavailable";
        code: string;
    } | {
        status: string;
    };
    execution: string;
    volumes: string;
    containerId?: string;
    exitCode?: number;
    oomKilled?: boolean;
    schemaVersion: number;
    runtime: string;
    storage: "sqlite" | "postgres";
    ownerId: string;
    resources: {
        container: string;
        initializer: string;
        stateVolume: string | undefined;
        configVolume: string;
        endpoint: string;
    };
    imageId: string;
    status: string;
}>;
/** Create only newly named owned resources, after an immutable private owner record has been durably published. */
export declare function startDockerOwner(input: StartDockerOwnerOptions, dependencies?: DockerOwnerDependencies): Promise<{
    execution: string;
    status: "paused" | "running" | "created" | "restarting" | "removing" | "exited" | "dead";
    containerId: string;
    exitCode: number;
    service?: never;
    observation?: never;
    schemaVersion: number;
    runtime: string;
    storage: "sqlite" | "postgres";
    owner: {
        path: string;
        bytes: number;
        sha256: string;
    };
    ownerId: string;
    resources: {
        container: string;
        initializer: string;
        stateVolume: string | undefined;
        configVolume: string;
        endpoint: string;
    };
    imageId: string;
} | {
    execution: string;
    status: string;
    containerId: string;
    service: {
        activeAsyncRuns?: number;
        status: "closed" | "ready" | "draining";
        instanceId: string;
        activeRequests: number;
    };
    exitCode?: never;
    observation?: never;
    schemaVersion: number;
    runtime: string;
    storage: "sqlite" | "postgres";
    owner: {
        path: string;
        bytes: number;
        sha256: string;
    };
    ownerId: string;
    resources: {
        container: string;
        initializer: string;
        stateVolume: string | undefined;
        configVolume: string;
        endpoint: string;
    };
    imageId: string;
} | {
    execution: string;
    status: string;
    containerId: string;
    service: {
        activeAsyncRuns?: number;
        status: "closed" | "ready" | "draining";
        instanceId: string;
        activeRequests: number;
    } | {
        retryAfterSeconds?: number;
        status: "unavailable";
        code: string;
    };
    observation: string;
    exitCode?: never;
    schemaVersion: number;
    runtime: string;
    storage: "sqlite" | "postgres";
    owner: {
        path: string;
        bytes: number;
        sha256: string;
    };
    ownerId: string;
    resources: {
        container: string;
        initializer: string;
        stateVolume: string | undefined;
        configVolume: string;
        endpoint: string;
    };
    imageId: string;
}>;
/** Signal only the exact reviewed container, never force-kill on observation timeout and never remove its volumes. */
export declare function stopDockerOwner(value: DockerOwner, containerId: string, waitMs?: number, dependencies?: DockerOwnerDependencies): Promise<{
    schemaVersion: number;
    runtime: string;
    storage: "sqlite" | "postgres";
    ownerId: string;
    containerId: string;
    status: string;
    exitCode: number;
    volumes: string;
    forceKill: boolean;
    container: string;
}>;
/** Reuse the same cleanly stopped container. This does not replace images, rotate config, repair locks or resume workflows. */
export declare function restartDockerOwner(value: DockerOwner, containerId: string, clientOptions: DockerOwnerClient, waitMs?: number, dependencies?: DockerOwnerDependencies): Promise<{
    execution: string;
    status: "paused" | "running" | "created" | "restarting" | "removing" | "exited" | "dead";
    containerId: string;
    exitCode: number;
    service?: never;
    observation?: never;
    schemaVersion: number;
    runtime: string;
    storage: "sqlite" | "postgres";
    ownerId: string;
    resources: {
        container: string;
        initializer: string;
        stateVolume: string | undefined;
        configVolume: string;
        endpoint: string;
    };
} | {
    execution: string;
    status: string;
    containerId: string;
    service: {
        activeAsyncRuns?: number;
        status: "closed" | "ready" | "draining";
        instanceId: string;
        activeRequests: number;
    };
    exitCode?: never;
    observation?: never;
    schemaVersion: number;
    runtime: string;
    storage: "sqlite" | "postgres";
    ownerId: string;
    resources: {
        container: string;
        initializer: string;
        stateVolume: string | undefined;
        configVolume: string;
        endpoint: string;
    };
} | {
    execution: string;
    status: string;
    containerId: string;
    service: {
        activeAsyncRuns?: number;
        status: "closed" | "ready" | "draining";
        instanceId: string;
        activeRequests: number;
    } | {
        retryAfterSeconds?: number;
        status: "unavailable";
        code: string;
    };
    observation: string;
    exitCode?: never;
    schemaVersion: number;
    runtime: string;
    storage: "sqlite" | "postgres";
    ownerId: string;
    resources: {
        container: string;
        initializer: string;
        stateVolume: string | undefined;
        configVolume: string;
        endpoint: string;
    };
}>;
export {};
