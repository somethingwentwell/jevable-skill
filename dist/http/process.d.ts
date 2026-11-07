import type { startRuntimeServer } from './server.ts';
type Service = Awaited<ReturnType<typeof startRuntimeServer>>;
type Signals = {
    on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
    off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
};
/** Own the CLI service lifetime, including signals received while storage/listener startup is pending. */
export declare function runServiceProcess(start: () => Promise<Service>, storage: 'sqlite' | 'postgres' | 'selected-owner', emit: (value: unknown) => void, drainWaitMs?: number, signals?: Signals, ready?: (service: Service) => object): Promise<number>;
export {};
