import { type ReleaseBackend } from './app.ts';
/** SQLite release entry. Its bundle never imports a PostgreSQL driver. */
export declare const sqliteReleaseBackend: ReleaseBackend;
export declare const releaseMain: (value: unknown, argv: string[], directory: string) => Promise<number>;
