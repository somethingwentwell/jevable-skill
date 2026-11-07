import type { DatabaseSync } from 'node:sqlite';
import { type AutomaticAdmissionLimits, type AutomaticAdmissionPage, type AutomaticAdmissionRecord } from './automatic-admission.ts';
/** Internal explicit owner migration only; no connection, schema repair or transaction ownership here. */
export declare function initializeAutomaticAdmissionTables(db: DatabaseSync): void;
/** Sole SQLite owner's durable evidence, never a recovered outbox. Reads/startup never call a transport. */
export declare class SQLiteAutomaticAdmissionStore {
    private readonly db;
    private readonly checks;
    private readonly limits;
    constructor(db: DatabaseSync, limits: AutomaticAdmissionLimits, checks: {
        history(record: AutomaticAdmissionRecord): void;
        delivery(requestId: string): unknown;
    });
    private decode;
    private read;
    private checked;
    private count;
    private atomic;
    get(id: string): AutomaticAdmissionRecord | undefined;
    page(value?: AutomaticAdmissionPage): {
        records: AutomaticAdmissionRecord[];
        nextCursor: string | null;
    };
    create(value: AutomaticAdmissionRecord): boolean;
    settle(value: AutomaticAdmissionRecord): void;
    /** Bidirectional bounded snapshot/audit verification only; a reserved row is left reserved, never dispatched. */
    validate(): void;
}
