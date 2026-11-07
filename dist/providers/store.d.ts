import type { DatabaseSync } from 'node:sqlite';
import { type ProviderConnectionRecord } from './config.ts';
import { type ModelEvidence } from './records.ts';
/** Private tables on the runtime-owned SQLite connection; no second database or competing lock. */
export declare class ProviderStore {
    private readonly database;
    private readonly maxRecordBytes;
    constructor(database: DatabaseSync, maxRecordBytes: number);
    private decode;
    connection(id: string): ProviderConnectionRecord | undefined;
    listConnections(): {
        generation: number;
        updatedAt: string;
        connection: {
            protocol: "openai-compatible";
            tokenParameter: "max_tokens" | "max_completion_tokens";
            maxStreamEvents: number;
            id: string;
            provider: string;
            endpoint: string;
            allowedModels: string[];
            authentication: {
                kind: "bearer";
                credentialRef: string;
            } | {
                kind: "none";
            };
            maxResponseBytes: number;
            maxRequestBytes: number;
            maxTimeoutSeconds: number;
            tracePropagation?: "none" | "w3c" | undefined;
            baggageKeys?: string[] | undefined;
        } | {
            protocol: "systemone";
            provider: "jev" | "laya";
            id: string;
            endpoint: string;
            allowedModels: string[];
            authentication: {
                kind: "bearer";
                credentialRef: string;
            } | {
                kind: "none";
            };
            maxResponseBytes: number;
            maxRequestBytes: number;
            maxTimeoutSeconds: number;
            tracePropagation?: "none" | "w3c" | undefined;
            baggageKeys?: string[] | undefined;
        };
    }[];
    private audit;
    private transaction;
    putConnection(value: unknown, expectedGeneration: number, actor: string): {
        generation: number;
        updatedAt: string;
        connection: {
            protocol: "openai-compatible";
            tokenParameter: "max_tokens" | "max_completion_tokens";
            maxStreamEvents: number;
            id: string;
            provider: string;
            endpoint: string;
            allowedModels: string[];
            authentication: {
                kind: "bearer";
                credentialRef: string;
            } | {
                kind: "none";
            };
            maxResponseBytes: number;
            maxRequestBytes: number;
            maxTimeoutSeconds: number;
            tracePropagation?: "none" | "w3c" | undefined;
            baggageKeys?: string[] | undefined;
        } | {
            protocol: "systemone";
            provider: "jev" | "laya";
            id: string;
            endpoint: string;
            allowedModels: string[];
            authentication: {
                kind: "bearer";
                credentialRef: string;
            } | {
                kind: "none";
            };
            maxResponseBytes: number;
            maxRequestBytes: number;
            maxTimeoutSeconds: number;
            tracePropagation?: "none" | "w3c" | undefined;
            baggageKeys?: string[] | undefined;
        };
    };
    credential(ref: string): string | undefined;
    /** One database read pins both the secret and its generation for an admitted side effect. */
    credentialSnapshot(ref: string): {
        value: string;
        generation: number;
    } | undefined;
    credentialStatus(ref: string): {
        ref: string;
        configured: boolean;
        generation: number;
        updatedAt?: never;
    } | {
        ref: string;
        configured: boolean;
        generation: number;
        updatedAt: string;
    };
    setCredential(ref: string, value: string, expectedGeneration: number, actor: string): {
        ref: string;
        configured: boolean;
        generation: number;
        updatedAt?: never;
    } | {
        ref: string;
        configured: boolean;
        generation: number;
        updatedAt: string;
    };
    /** Clear only an exact active generation; retained metadata is not secure physical erasure. */
    clearCredential(ref: string, expectedGeneration: number, actor: string): {
        ref: string;
        configured: boolean;
        generation: number;
        updatedAt?: never;
    } | {
        ref: string;
        configured: boolean;
        generation: number;
        updatedAt: string;
    };
    evidence(id: string): ModelEvidence | undefined;
    /** Exact request and retry policy are immutable; only the next admitted evidence transition can commit. */
    saveEvidence(record: ModelEvidence): void;
    auditEvents(): Record<string, import("node:sqlite").SQLOutputValue>[];
}
