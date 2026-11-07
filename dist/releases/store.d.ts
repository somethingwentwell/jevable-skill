import type { DatabaseSync } from 'node:sqlite';
import { type Release } from './snapshot.ts';
/** Immutable snapshots. Imported creator/project fields are provenance claims, not local approvals. */
export declare class ReleaseStore {
    private readonly db;
    private readonly maxBytes;
    constructor(db: DatabaseSync, maxBytes: number);
    get(id: string): Release;
    list(): Release[];
    put(value: unknown, reuse?: boolean): Release;
}
