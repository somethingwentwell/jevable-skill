import { PostgresJournal } from '../storage/postgres.ts';
import { type Release, type ReleaseCreateCommand } from './snapshot.ts';
export type PostgresReleaseCommand = ReleaseCreateCommand;
/** Immutable releases; local review creation and external provenance import are distinct operations. */
export declare class PostgresReleaseStore {
    private readonly journal;
    private readonly maxRecordBytes;
    private readonly projects;
    constructor(journal: PostgresJournal, maxRecordBytes?: number);
    private decode;
    private read;
    private index;
    get(id: string): Promise<Release>;
    list(after?: string, limit?: number): Promise<{
        releases: Release[];
        nextCursor: string | null;
    }>;
    private mutate;
    private admit;
    private save;
    create(value: PostgresReleaseCommand): Promise<Release>;
    /** Import an executable snapshot, not an approval. Origin project/creator fields remain external claims. */
    put(value: unknown, reuse?: boolean): Promise<Release>;
}
