import { type CliIO } from './process/cli-output.ts';
/** CLI entry is reusable in tests; importing the SDK never launches a process or a server. */
export declare function main(argv: string[], io?: CliIO): Promise<number>;
