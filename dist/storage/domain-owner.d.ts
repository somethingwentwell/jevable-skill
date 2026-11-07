import type { PostgresJournal } from './postgres.ts';
/** Synchronous metadata projection; never enters the domain gate or queries storage. */
export declare function domainQueueOccupancy(journal: PostgresJournal): {
    waiting: number;
    active: number;
};
/** Serialize domain read/guard/write operations on one owner; never nest this gate or perform external effects inside it. */
export declare function withDomainWrite<T>(journal: PostgresJournal, work: () => Promise<T>): Promise<T>;
