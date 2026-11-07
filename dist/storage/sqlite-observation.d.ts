import type { DatabaseSync } from 'node:sqlite';
import { SQLiteStatementStatistics } from './sqlite-statistics.ts';
/** Wrap only this owner's connection; never patch native prototypes or install ambient instrumentation. */
export declare function observeSQLiteDatabase(database: DatabaseSync, statistics: SQLiteStatementStatistics, clock?: () => number): DatabaseSync;
