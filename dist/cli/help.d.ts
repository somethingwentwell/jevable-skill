import { z } from 'zod';
/** Discovery paths only. Flag/count declarations come from the dispatcher, not this index. */
export declare const CLI_HELP_PATHS: readonly ["capabilities", "doctor", "kubernetes capacity", "validate", "preview", "check", "run", "runtime lock inspect", "runtime lock recover", "runtime lock inspect-recovery", "runtime lock complete-recovery", "schemas list", "schemas show", "skill export", "skill inspect", ...string[]];
export declare class CliHelpInputError extends Error {
}
export interface HelpRequest {
    path: string[];
    json: boolean;
}
/** Only bare command paths are help requests. Never ignore a submitted input or service option. */
export declare function parseHelpRequest(argv: string[]): HelpRequest | undefined;
export interface HelpGrammar {
    positionals: number;
    strings: readonly string[];
    booleans: readonly string[];
}
export declare class CliCommandHelp extends Error {
    readonly variants: {
        profile: string;
        grammar: HelpGrammar;
    }[];
    constructor(variants: {
        profile: string;
        grammar: HelpGrammar;
    }[]);
}
export declare function commandHelp(argv: string[], positionals: number, strings: readonly string[], booleans: readonly string[]): never;
export declare function helpReport(path: string[], variants?: {
    profile: string;
    grammar: HelpGrammar;
}[]): {
    notes: string[];
    references: string[];
    referenceLocation: string;
    exitCodes: {
        '0': string;
        '1': string;
        '2': string;
        '3': string;
        '4': string;
        '5': string;
        '6': string;
        '7': string;
        '8': string;
        '130': string;
        '143': string;
    };
    variants: {
        profile: string;
        positionalCount: number;
        positionalArguments: string[];
        options: Record<string, "string" | "boolean">;
        requirements: {
            positionals: {
                index: number;
                format: "uuid";
            }[];
            scope: "flag-presence, finite choices, integer bounds and argument formats; file schemas, combinations, review and authority still apply";
            rules: import("./requirements.ts").CliFlagRule[];
        };
    }[];
    attachmentContracts?: {
        id: string;
        flag: string;
        checksumFlag: string;
        schema: z.core.ZodStandardJSONSchemaPayload<z.ZodObject<{
            id: z.ZodUUID;
            generation: z.ZodNumber;
            revision: z.ZodString;
        }, z.core.$strict>>;
        sha256: string;
        validation: string;
        references: string[];
        limits: string;
    }[];
    startupContracts?: {
        id: string;
        flag: string;
        schema: z.core.ZodStandardJSONSchemaPayload<z.ZodObject<{
            source: z.ZodString;
            keys: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        sha256: string;
        validation: string;
        references: string[];
        limits: string;
    }[];
    inputContracts?: {
        id: "release-message-identity" | "async-run-start" | "async-release-pin" | "async-run-policy" | "http-rate-limits";
        schema: z.core.ZodStandardJSONSchemaPayload<z.ZodObject<{
            release: z.ZodObject<{
                id: z.ZodUUID;
                sha256: z.ZodString;
                revision: z.ZodString;
            }, z.core.$strict>;
            source: z.ZodString;
            messageId: z.ZodString;
        }, z.core.$strict> | z.ZodObject<{
            maxConcurrentRuns: z.ZodNumber;
        }, z.core.$strict> | z.ZodObject<{
            id: z.ZodUUID;
            sha256: z.ZodString;
            revision: z.ZodString;
        }, z.core.$strict> | z.ZodDiscriminatedUnion<[z.ZodObject<{
            yaml: z.ZodString;
            id: z.ZodUUID;
            input: z.ZodJSONSchema;
            paused: z.ZodOptional<z.ZodBoolean>;
            triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
            kind: z.ZodLiteral<"workflow">;
        }, z.core.$strict>, z.ZodObject<{
            project: z.ZodObject<{
                id: z.ZodUUID;
                generation: z.ZodNumber;
                revision: z.ZodString;
            }, z.core.$strict>;
            id: z.ZodUUID;
            input: z.ZodJSONSchema;
            paused: z.ZodOptional<z.ZodBoolean>;
            triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
            kind: z.ZodLiteral<"project">;
        }, z.core.$strict>, z.ZodObject<{
            release: z.ZodObject<{
                id: z.ZodUUID;
                sha256: z.ZodString;
                revision: z.ZodString;
            }, z.core.$strict>;
            id: z.ZodUUID;
            input: z.ZodJSONSchema;
            paused: z.ZodOptional<z.ZodBoolean>;
            triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
            kind: z.ZodLiteral<"release">;
        }, z.core.$strict>], "kind"> | z.ZodObject<{
            requests: z.ZodObject<{
                capacity: z.ZodNumber;
                refillTokens: z.ZodNumber;
                refillIntervalMs: z.ZodNumber;
            }, z.core.$strict>;
            controls: z.ZodObject<{
                capacity: z.ZodNumber;
                refillTokens: z.ZodNumber;
                refillIntervalMs: z.ZodNumber;
            }, z.core.$strict>;
        }, z.core.$strict>>;
        sha256: string;
        validation: string;
        references: string[];
        limits: string;
    }[];
    schemaVersion: number;
    version: string;
    kind: string;
    command: string | null;
    execution: string;
    output: {
        stdoutUnit: string;
        stderrUnit: string;
        failureExitCode: number;
        signalExitCodesTakePrecedence: boolean;
        truncation: string;
        replay: string;
        limits: string;
        stdoutBytes: 32000000;
        stderrBytes: 64000;
        pendingBytes: 64000000;
        encoding: string;
    };
} | {
    notes: string[];
    references: string[];
    referenceLocation: string;
    exitCodes: {
        '0': string;
        '1': string;
        '2': string;
        '3': string;
        '4': string;
        '5': string;
        '6': string;
        '7': string;
        '8': string;
        '130': string;
        '143': string;
    };
    commands: string[];
    attachmentContracts?: {
        id: string;
        flag: string;
        checksumFlag: string;
        schema: z.core.ZodStandardJSONSchemaPayload<z.ZodObject<{
            id: z.ZodUUID;
            generation: z.ZodNumber;
            revision: z.ZodString;
        }, z.core.$strict>>;
        sha256: string;
        validation: string;
        references: string[];
        limits: string;
    }[];
    startupContracts?: {
        id: string;
        flag: string;
        schema: z.core.ZodStandardJSONSchemaPayload<z.ZodObject<{
            source: z.ZodString;
            keys: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
        sha256: string;
        validation: string;
        references: string[];
        limits: string;
    }[];
    inputContracts?: {
        id: "release-message-identity" | "async-run-start" | "async-release-pin" | "async-run-policy" | "http-rate-limits";
        schema: z.core.ZodStandardJSONSchemaPayload<z.ZodObject<{
            release: z.ZodObject<{
                id: z.ZodUUID;
                sha256: z.ZodString;
                revision: z.ZodString;
            }, z.core.$strict>;
            source: z.ZodString;
            messageId: z.ZodString;
        }, z.core.$strict> | z.ZodObject<{
            maxConcurrentRuns: z.ZodNumber;
        }, z.core.$strict> | z.ZodObject<{
            id: z.ZodUUID;
            sha256: z.ZodString;
            revision: z.ZodString;
        }, z.core.$strict> | z.ZodDiscriminatedUnion<[z.ZodObject<{
            yaml: z.ZodString;
            id: z.ZodUUID;
            input: z.ZodJSONSchema;
            paused: z.ZodOptional<z.ZodBoolean>;
            triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
            kind: z.ZodLiteral<"workflow">;
        }, z.core.$strict>, z.ZodObject<{
            project: z.ZodObject<{
                id: z.ZodUUID;
                generation: z.ZodNumber;
                revision: z.ZodString;
            }, z.core.$strict>;
            id: z.ZodUUID;
            input: z.ZodJSONSchema;
            paused: z.ZodOptional<z.ZodBoolean>;
            triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
            kind: z.ZodLiteral<"project">;
        }, z.core.$strict>, z.ZodObject<{
            release: z.ZodObject<{
                id: z.ZodUUID;
                sha256: z.ZodString;
                revision: z.ZodString;
            }, z.core.$strict>;
            id: z.ZodUUID;
            input: z.ZodJSONSchema;
            paused: z.ZodOptional<z.ZodBoolean>;
            triggerMode: z.ZodOptional<z.ZodLiteral<"api">>;
            kind: z.ZodLiteral<"release">;
        }, z.core.$strict>], "kind"> | z.ZodObject<{
            requests: z.ZodObject<{
                capacity: z.ZodNumber;
                refillTokens: z.ZodNumber;
                refillIntervalMs: z.ZodNumber;
            }, z.core.$strict>;
            controls: z.ZodObject<{
                capacity: z.ZodNumber;
                refillTokens: z.ZodNumber;
                refillIntervalMs: z.ZodNumber;
            }, z.core.$strict>;
        }, z.core.$strict>>;
        sha256: string;
        validation: string;
        references: string[];
        limits: string;
    }[];
    schemaVersion: number;
    version: string;
    kind: string;
    command: string | null;
    execution: string;
    output: {
        stdoutUnit: string;
        stderrUnit: string;
        failureExitCode: number;
        signalExitCodesTakePrecedence: boolean;
        truncation: string;
        replay: string;
        limits: string;
        stdoutBytes: 32000000;
        stderrBytes: 64000;
        pendingBytes: 64000000;
        encoding: string;
    };
};
export declare function renderHelp(report: ReturnType<typeof helpReport>): string;
