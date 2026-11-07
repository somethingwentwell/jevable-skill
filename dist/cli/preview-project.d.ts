import { type CliValues } from './runtime.ts';
/** Exact file checksum and workflow revision, before credentials, target contact or storage. */
export declare function readPreviewProjectPin(source: string, values: CliValues): Promise<{
    id: string;
    generation: number;
    revision: string;
} | undefined>;
