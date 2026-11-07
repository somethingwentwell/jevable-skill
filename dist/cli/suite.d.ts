import { type CliValues } from './runtime.ts';
/** Preserve the suite's explicit loopback-HTTP mode; never read the manifest to select an owner. */
export declare function suiteSelection(values: CliValues): 'selected' | 'http' | 'local';
export declare function suiteFromCli(action: 'create' | 'inspect' | 'run' | 'result' | 'coverage', path: string, values: CliValues, emit: (value: unknown) => void): Promise<number>;
