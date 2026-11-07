/** Versioned native answer contract, shared by compilation, execution and wire admission. */
import type { WorkflowDecisionQuestion } from './decision-types.ts';
import type { WorkflowValueSchemaDefinition } from './value-types.ts';
export type SystemOneAnswer = {
    readonly type: 'choice';
    readonly choice: string;
    readonly confidence: number;
    readonly probabilities: Readonly<Record<string, number>>;
} | {
    readonly type: 'score';
    readonly score: number;
    readonly confidence: number;
    readonly legend: Readonly<Record<string, string>>;
    readonly probabilities: Readonly<Record<string, number>>;
} | {
    readonly type: 'noul';
    readonly noul: number;
};
export declare const SYSTEMONE_ROUNDING_TOLERANCE = 0.00001;
export declare function systemOneAnswerSchema(question: WorkflowDecisionQuestion): WorkflowValueSchemaDefinition;
/** Shape/range validation precedes this semantic check. No renormalization or derived confidence. */
export declare function assertSystemOneAnswers(questions: Readonly<Record<string, WorkflowDecisionQuestion>>, answers: Readonly<Record<string, SystemOneAnswer>>): void;
