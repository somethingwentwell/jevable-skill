import { z } from 'zod';
import { PostgresJournal } from '../storage/postgres.ts';
import { type WorkflowCompilerLimits } from '../workflow/index.ts';
import { type LocalRun } from './run-types.ts';
import { runEventKind } from './run-transition.ts';
export interface PostgresRunEvent {
    sequence: string;
    version: string;
    kind: z.infer<typeof runEventKind>;
    at: string;
    data: unknown;
}
/** Internal verified reads; caller must hold the shared domain queue for a coherent read/guard/write operation. */
export declare class PostgresRunReader {
    private readonly journal;
    private readonly limits;
    private readonly maxRecordBytes;
    private readonly projects;
    private readonly releases;
    private readonly tests;
    private readonly models;
    private readonly ledger;
    private readonly grants;
    constructor(journal: PostgresJournal, limits?: WorkflowCompilerLimits, maxRecordBytes?: number);
    private parse;
    private history;
    checked(record: LocalRun, events: readonly {
        kind: string;
        data: unknown;
    }[], current?: boolean): Promise<import("../workflow/compiler-types.ts").CompiledWorkflow>;
    read(id: string): Promise<{
        record: LocalRun;
        version: string;
        events: PostgresRunEvent[];
        graph: import("../workflow/compiler-types.ts").CompiledWorkflow;
    }>;
}
