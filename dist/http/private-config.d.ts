/** Private configuration can contain credentials. Never print parse errors, paths or file content. */
export declare function readPrivateConfig(path: string, maxBytes?: number): Promise<unknown>;
