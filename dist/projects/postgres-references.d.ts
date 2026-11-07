import type { PostgresJournal } from '../storage/postgres.ts';
import type { WorkflowCompilerLimits } from '../workflow/index.ts';
/** Internal guard: caller owns the domain queue until its deletion commits. No external effects or nested gate. */
export declare function requireUnreferencedProject(journal: PostgresJournal, id: string, limits: WorkflowCompilerLimits, maxRecordBytes: number): Promise<void>;
