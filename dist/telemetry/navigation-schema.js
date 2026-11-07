import { z } from 'zod';
import { traceNavigationTools } from "./navigation.js";
/** Structural discovery plus the same import-free semantic admission used by SDK/preview/browser projections. */
export const traceViewerConfigSchema = z.union([
    z.strictObject({ schemaVersion: z.literal(1), origin: z.string().min(1).max(512), pathTemplate: z.string().min(1).max(1024),
        spanParameter: z.enum(['spanID', 'spanId', 'span']).optional() }),
    z.strictObject({ schemaVersion: z.literal(2), kind: z.literal('grafana-tempo-explore'), origin: z.string().min(1).max(512),
        datasourceUid: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), orgId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        range: z.strictObject({ from: z.string().min(1).max(24), to: z.string().min(1).max(24) }),
        pathPrefix: z.string().min(1).max(256).optional() }),
]).refine(value => { try {
    traceNavigationTools().config(value);
    return true;
}
catch {
    return false;
} }, 'Invalid credential-free trace viewer configuration.');
