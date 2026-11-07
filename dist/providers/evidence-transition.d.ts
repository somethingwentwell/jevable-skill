import type { ModelEvidence } from './records.ts';
/** Derivable storage generation; version 1 retains its original one-intent/one-settlement shape. */
export declare function modelEvidenceVersion(record: ModelEvidence): number;
/** Storage must call this inside its write guard after schema admission; terminal or historical bytes cannot be rewritten. */
export declare function validateModelEvidenceTransition(previous: ModelEvidence | undefined, next: ModelEvidence): undefined;
