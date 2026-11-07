import { z } from 'zod';
import type { TestRecord, TestLedger } from './ledger.ts';
import type { Project } from '../projects/ledger.ts';
/** Shared replay checks for direct reads and coherent project/test export. */
export declare function decodePostgresTest(row: {
    key: string;
    version: string;
    value: unknown;
}, ledger: TestLedger, project: (id: string, generation: number) => Promise<Project>, maxRecordBytes: number): Promise<TestRecord>;
/** Shared encoding for ordinary case writes and atomic project/test imports. Does not commit. */
export declare function postgresTestWrite(record: TestRecord, expectedVersion: string, maxRecordBytes: number): {
    change: {
        operation: "put";
        collection: "projects" | "runs" | "releases" | "access-grants" | "project-deletions" | "release-versions" | "test-cases" | "test-generations" | "provider-connections" | "provider-credentials" | "model-calls" | "approval-deliveries" | "approval-delivery-subjects" | "test-erasures" | "test-erasure-subjects" | "approval-automatic-admissions";
        key: string;
        expectedVersion: string;
        value: z.core.util.JSONType;
    };
    event: {
        collection: "projects" | "runs" | "releases" | "access-grants" | "project-deletions" | "release-versions" | "test-cases" | "test-generations" | "provider-connections" | "provider-credentials" | "model-calls" | "approval-deliveries" | "approval-delivery-subjects" | "test-erasures" | "test-erasure-subjects" | "approval-automatic-admissions";
        key: string;
        kind: string;
        data: z.core.util.JSONType;
    };
};
