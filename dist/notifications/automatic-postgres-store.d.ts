import { PostgresJournal } from '../storage/postgres.ts';
import { type AutomaticAdmissionLimits, type AutomaticAdmissionPage, type AutomaticAdmissionRecord } from './automatic-admission.ts';
/** One PostgreSQL journal owner and domain queue; no external effects, recovered queue or replay. */
export declare class PostgresAutomaticAdmissionStore {
    private readonly journal;
    private readonly checks;
    private readonly limits;
    constructor(journal: PostgresJournal, limits: AutomaticAdmissionLimits, checks: {
        history(record: AutomaticAdmissionRecord): Promise<void>;
        delivery(requestId: string): Promise<unknown>;
    });
    private owned;
    private read;
    private checked;
    get(id: string): Promise<AutomaticAdmissionRecord | undefined>;
    page(value?: AutomaticAdmissionPage): Promise<{
        records: AutomaticAdmissionRecord[];
        nextCursor: string | null;
    }>;
    create(value: AutomaticAdmissionRecord): Promise<boolean>;
    settle(value: AutomaticAdmissionRecord): Promise<void>;
    /** Verify both directions, including versions and every creation/settlement event. Never settles or dispatches reserved rows. */
    validate(): Promise<void>;
}
