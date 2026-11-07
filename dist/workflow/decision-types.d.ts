/** Provider-neutral typed questions and normalized answers; provider envelopes remain adapter-owned. */
/** One classification, ordered rubric or yes/no proposition evaluated over the node's bound state. */
export type WorkflowDecisionQuestion = {
    readonly type: 'choice';
    readonly instructions: string;
    readonly criteria: Readonly<Record<string, string>>;
} | {
    readonly type: 'score';
    readonly instructions: string;
    readonly criteria: readonly string[];
} | {
    readonly type: 'noul';
    readonly instructions: string;
};
/** Normalized answer metadata; confidence is provider-reported, not a guarantee of calibration. */
export type WorkflowDecisionAnswer = ({
    readonly type: 'choice';
    readonly choice: string;
    readonly probabilities: Readonly<Record<string, number>>;
} | {
    readonly type: 'score';
    readonly score: number;
    readonly probabilities: readonly number[];
} | {
    readonly type: 'noul';
    readonly probability: number;
}) & {
    readonly confidence: number;
    readonly explanation?: string;
};
