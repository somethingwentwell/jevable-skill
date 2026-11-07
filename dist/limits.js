import { deepFreeze } from "./shared/values.js";
/** Default offline policy; SDK callers may provide an explicit deployment policy instead. */
export const DEFAULT_COMPILER_LIMITS = deepFreeze({
    source: { maxSourceBytes: 1_000_000, maxDepth: 64, maxValues: 100_000, maxNodes: 500, maxEdges: 1_000 },
    schema: { maxBytes: 100_000, maxDepth: 32, maxValues: 10_000 },
    binding: { data: { maxBytes: 1_000_000, maxDepth: 64, maxValues: 100_000 },
        expression: { maxSourceBytes: 8_192, maxNodes: 1_000, maxDepth: 32, maxResultBytes: 1_000_000 }, maxExpressions: 1_000 },
});
