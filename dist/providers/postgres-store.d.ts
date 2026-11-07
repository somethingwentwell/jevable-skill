import { PostgresJournal } from '../storage/postgres.ts';
import { type ModelEvidence } from './records.ts';
import type { ProviderPersistence } from './persistence.ts';
/** Domain-validated PostgreSQL credentials, provider configuration and immutable model evidence. */
export declare class PostgresProviderStore implements ProviderPersistence {
    private readonly journal;
    private readonly maxRecordBytes;
    constructor(journal: PostgresJournal, maxRecordBytes?: number);
    get signal(): AbortSignal;
    private parse;
    private ref;
    private generation;
    private mutate;
    private row;
    private connectionRecord;
    connection(id: string): Promise<{
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
    } | undefined>;
    listConnections(): Promise<{
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
    }[]>;
    putConnection(value: unknown, expectedGeneration: number, actor: string): Promise<{
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
    }>;
    private credentialRecord;
    credential(ref: string): Promise<string | undefined>;
    credentialSnapshot(ref: string): Promise<{
        value: string;
        generation: number;
    } | undefined>;
    credentialStatus(ref: string): Promise<{
        ref: string;
        configured: boolean;
        generation: number;
        updatedAt: string;
    } | {
        ref: string;
        configured: boolean;
        generation: number;
        updatedAt?: never;
    }>;
    setCredential(ref: string, value: string, expectedGeneration: number, actor: string): Promise<{
        ref: string;
        configured: boolean;
        generation: number;
        updatedAt: string;
    }>;
    /** Retain a secret-free generation atomically with the metadata-only audit event. */
    clearCredential(ref: string, expectedGeneration: number, actor: string): Promise<{
        ref: string;
        configured: boolean;
        generation: number;
        updatedAt: string;
    }>;
    private id;
    evidence(id: string): Promise<ModelEvidence | undefined>;
    saveEvidence(value: ModelEvidence): Promise<void>;
    auditEvents(after?: string, limit?: number): Promise<{
        cursor: string;
        events: {
            subject: string;
            generation: number;
            actor: string;
            at: string;
            sequence: string;
            kind: string;
        }[];
    }>;
}
