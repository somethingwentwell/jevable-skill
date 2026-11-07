import type { CliValues } from './runtime.ts';
export declare const ACCOUNT_ACTIONS: readonly ["prepare", "inspect", "link", "exchange", "status", "revoke"];
export type AccountAction = typeof ACCOUNT_ACTIONS[number];
export declare class AccountCliInputError extends Error {
    constructor();
}
export declare function accountStrings(action: AccountAction): string[];
export declare function accountBooleans(action: AccountAction): string[];
/** Pure transport/selection admission before CA, session or code reads. */
export declare function accountSelection(action: AccountAction, values: CliValues): void;
type Admit = <T>(work: () => Promise<T>) => Promise<T>;
/** No browser/process discovery or workflow owner is opened; code input precedes signal-held admission. */
export declare function accountFromCli(action: AccountAction, values: CliValues, admit: Admit): Promise<unknown>;
export {};
