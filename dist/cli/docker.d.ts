import { type CliValues } from './runtime.ts';
export declare const dockerFlags: {
    start: string[];
    inspect: string[];
    stop: string[];
    restart: string[];
};
export declare function dockerFromCli(action: keyof typeof dockerFlags, values: CliValues): Promise<{
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
} | {
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
} | {
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
