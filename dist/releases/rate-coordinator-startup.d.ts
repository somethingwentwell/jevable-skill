import { type ReleaseBackend } from './app.ts';
/** Only explicitly bundled quota-capable entries import this adapter. No workflow database owner. */
export declare const preparePostgresReleaseRateCoordinator: NonNullable<ReleaseBackend['prepareRateCoordinator']>;
