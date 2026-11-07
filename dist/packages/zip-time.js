/** ZIP stores local DOS calendar fields, not a UTC instant. Keep those fields identical in every timezone. */
export function zipEpoch() { return new Date(1980, 0, 1, 0, 0, 0); }
