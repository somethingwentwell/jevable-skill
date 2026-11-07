/** Optional diagnostics cannot suppress, duplicate or replace actual persistence work. */
export type ObservationScope = <T>(work: () => T) => T;
export declare function withObservationScope<T>(scope: ObservationScope | undefined, work: () => T): T;
