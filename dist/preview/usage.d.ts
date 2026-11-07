import type { UsageReport, UsageSelection } from '../evidence/usage.ts';
export type PreviewUsageQuery = {
    runId: string;
    revision: string;
    window?: {
        from: string;
        before: string;
    };
    groupBy?: 'provider' | 'provider-model';
};
export type PreviewUsage = {
    schemaVersion: 1;
    format: 'jevable.ai/preview-usage';
    selection: UsageSelection;
    selectionSha256: string;
    run: Omit<UsageReport['runs'][number], 'calls' | 'summary' | 'groups' | 'windowCoverage'>;
    summary: UsageReport['summary'];
    windowCoverage?: UsageReport['windowCoverage'];
    groups?: UsageReport['groups'];
};
/** Import-free browser admission. Checks scope/accounting shape, not provider bills or independent journal authenticity. */
export declare function previewUsageTools(): {
    query: (v: PreviewUsageQuery) => {
        groupBy?: "provider" | "provider-model";
        window?: {
            from: string;
            before: string;
        };
        schemaVersion: 1;
        runs: {
            id: string;
            revision: string;
        }[];
    };
    admit: (expected: PreviewUsageQuery, value: unknown) => Promise<PreviewUsage>;
};
/** Only the selected run's checked report summary leaves the preview owner; detailed calls stay in existing evidence views. */
export declare function projectPreviewUsage(expected: PreviewUsageQuery, raw: unknown): Promise<PreviewUsage>;
