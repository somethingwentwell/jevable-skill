import { type CliValues } from './runtime.ts';
export declare function watchFromCli(id: string, values: CliValues, out: (line: string) => void, signals?: {
    on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
    removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}): Promise<number>;
