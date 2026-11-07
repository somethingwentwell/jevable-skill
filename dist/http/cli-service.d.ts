export declare class RuntimeStartupError extends Error {
    readonly code: string;
    constructor(code: string);
}
export declare class RuntimeServiceUsageError extends Error {
    constructor();
}
export declare function serveFromCli(values: Record<string, string | boolean | undefined>, token: string, emit: (value: unknown) => void): Promise<number>;
