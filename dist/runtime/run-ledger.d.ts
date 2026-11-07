import { type WorkflowCompilerLimits, type CompiledWorkflow } from '../workflow/index.ts';
import type { Project } from '../projects/ledger.ts';
import type { Release } from '../releases/snapshot.ts';
import type { TestCase } from '../testing/schema.ts';
import { type LocalRun } from './run-types.ts';
import type { GrantMetadata } from '../access/grants.ts';
/** Resolved domain snapshots, already checked by their storage adapters; no database calls during replay. */
export interface RunReplayEvidence {
    events: readonly {
        kind: string;
        data: unknown;
    }[];
    project?: Project;
    release?: Release;
    test?: TestCase;
    grant?: GrantMetadata;
    reviewerGrants?: readonly GrantMetadata[];
}
/** Shared checkpoint/review/control/cancellation replay; never dispatches models or other workflow effects. */
export declare class RunLedger {
    private readonly limits;
    constructor(limits: WorkflowCompilerLimits);
    check(record: LocalRun, evidence: RunReplayEvidence): CompiledWorkflow;
}
