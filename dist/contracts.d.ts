/** Offline input-shape discovery generated from the same schemas used by core admission. */
import { z } from 'zod';
export declare class SchemaDiscoveryError extends Error {
    constructor();
}
export declare function listSchemas(): {
    schemaVersion: number;
    version: string;
    kind: "schema-index";
    execution: "not-dispatched";
    schemas: {
        id: string;
        summary: string;
        references: string[];
        limits: string;
    }[];
    notes: string[];
    referenceLocation: string;
};
/** Input projection throws for unrepresentable types; never weaken one to an empty schema. */
export declare function showSchema(id: string): {
    validation: "structural-input-projection-only";
    dialect: string;
    sha256: string;
    schema: z.core.ZodStandardJSONSchemaPayload<z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>>;
    notes: string[];
    referenceLocation: string;
    id: string;
    summary: string;
    references: string[];
    limits: string;
    schemaVersion: number;
    version: string;
    kind: "schema";
    execution: "not-dispatched";
};
