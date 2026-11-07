/** Shared, I/O-free CLI argument admission and help metadata.
 * File schemas, review guards and authority remain the operation's responsibility.
 */
import type { CliValues } from './runtime.ts';
export declare class CliFlagRequirementsError extends Error {
}
export type CliFlagCondition = {
    flag: string;
    equals?: string | boolean;
    present?: true;
} | {
    any: CliFlagCondition[];
};
export type CliFlagRule = {
    kind: 'required' | 'together' | 'exactly-one';
    flags: string[];
    when?: CliFlagCondition;
} | {
    kind: 'fixed';
    flag: string;
    value: string;
} | {
    kind: 'choices';
    flag: string;
    values: string[];
} | {
    kind: 'integer';
    flag: string;
    minimum: number;
    maximum: number;
    encoding: 'canonical-unsigned-decimal';
    defaultValue?: number;
} | {
    kind: 'format';
    flag: string;
    format: CliArgumentFormat;
};
export type CliArgumentFormat = 'uuid' | 'sha256' | 'docker-id' | 'audit-sequence';
export declare function cliArgumentFormatDescription(format: CliArgumentFormat): string;
/** File paths, credential references and template IDs are intentionally not UUIDs. */
export declare function cliPositionalRequirements(path: string, count: number): {
    index: number;
    format: "uuid";
}[];
/** Rules use only declared parser flags. No filesystem, service or environment discovery. */
export declare function cliFlagRequirements(path: string, options: Readonly<Record<string, 'string' | 'boolean'>>, profile?: string): {
    scope: "flag-presence, finite choices, integer bounds and argument formats; file schemas, combinations, review and authority still apply";
    rules: CliFlagRule[];
};
export declare function validateCliFlagRequirements(path: string, values: CliValues, options: Readonly<Record<string, 'string' | 'boolean'>>, positionals?: readonly string[]): void;
