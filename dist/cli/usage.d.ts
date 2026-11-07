/** Storage-free CLI definitions, also used by independently bundled workflow apps. */
export type CliValues = Record<string, string | boolean | undefined>;
export declare class CliStorageUsageError extends Error {
    constructor(message?: string);
}
