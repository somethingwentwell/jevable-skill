import type { PreviewProjectPin } from './release.ts';
import type { PreviewReleaseEvidence } from './release-download.ts';
/** Browser-safe receipt/byte verification. The server validates project/history/tests and ZIP entries. */
export declare function prepareProjectDownload(expected: {
    project: PreviewProjectPin;
    options: {
        history: boolean;
        tests: boolean;
    };
}, value: unknown, evidence?: PreviewReleaseEvidence | null): Promise<{
    bytes: Uint8Array<ArrayBuffer>;
    sha256: string;
    bundleSha256: string;
    tests: {
        included: boolean;
        count: number;
        excludedOtherRevisions: number;
    };
    filename: string;
}>;
