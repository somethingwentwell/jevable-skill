import type { WorkflowValueSchemaDefinition as Schema } from '../workflow/index.ts';
/** Pure, serializable input tools. Client checks aid editing; runtime admission remains authoritative. */
export declare function schemaInputTools(): {
    limits: {
        bytes: number;
        values: number;
        depth: number;
        fields: number;
        formDepth: number;
        arrayItems: number;
        enumItems: number;
    };
    snapshot: (value: unknown) => any;
    parse: (text: string) => any;
    schema: (value: unknown) => Schema;
    compatible: (s: Schema, input: unknown) => any;
    seed: (s: Schema) => any;
    scalar: (s: Schema, text: string) => any;
    validate: (s: Schema, input: unknown) => any;
};
