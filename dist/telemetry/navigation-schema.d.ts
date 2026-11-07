import { z } from 'zod';
/** Structural discovery plus the same import-free semantic admission used by SDK/preview/browser projections. */
export declare const traceViewerConfigSchema: z.ZodUnion<readonly [z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    origin: z.ZodString;
    pathTemplate: z.ZodString;
    spanParameter: z.ZodOptional<z.ZodEnum<{
        spanId: "spanId";
        span: "span";
        spanID: "spanID";
    }>>;
}, z.core.$strict>, z.ZodObject<{
    schemaVersion: z.ZodLiteral<2>;
    kind: z.ZodLiteral<"grafana-tempo-explore">;
    origin: z.ZodString;
    datasourceUid: z.ZodString;
    orgId: z.ZodNumber;
    range: z.ZodObject<{
        from: z.ZodString;
        to: z.ZodString;
    }, z.core.$strict>;
    pathPrefix: z.ZodOptional<z.ZodString>;
}, z.core.$strict>]>;
