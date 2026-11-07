import { type CliValues } from './runtime.ts';
type Check = {
    id: string;
    status: 'pass' | 'warning' | 'fail';
    code: string;
    message: string;
};
export declare function supportedNodeVersion(version: string): boolean;
/** I/O-free diagnostic scope admission, also used before dispatcher handoff. */
export declare function doctorSelection(values: CliValues): {
    endpoint: string | undefined;
    storage: "sqlite" | "postgres" | undefined;
    timeout: number;
};
/** No store is opened, no subprocess launched and no network used unless an endpoint is explicit. */
export declare function doctor(values: CliValues): Promise<{
    schemaVersion: number;
    status: string;
    version: string;
    protocolVersion: string;
    node: string;
    platform: NodeJS.Platform;
    architecture: NodeJS.Architecture;
    mode: string;
    checks: Check[];
    runtimeReadiness: string;
    execution: string;
    mutations: string;
    network: string;
    notChecked: string[];
}>;
export {};
