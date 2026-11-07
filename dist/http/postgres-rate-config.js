/** Driver-free shared quota admission; no environment lookup or database I/O. */
import { z } from 'zod';
import { postgresConfigSchema, parsePostgresConfiguration } from "../storage/postgres-config.js";
import { httpRateLimitsSchema } from "./rate-limits.js";
const connectionSchema = postgresConfigSchema.pick({ host: true, port: true, database: true, user: true, password: true, tls: true });
export const postgresHttpRateCoordinatorOptionsSchema = z.strictObject({ connection: connectionSchema,
    scope: z.uuid().transform(value => value.toLowerCase()), policy: httpRateLimitsSchema, initialize: z.boolean(),
    timeoutMs: z.number().int().min(100).max(5000), statementTimeoutMs: z.number().int().min(100).max(5000),
    maxPendingDebits: z.number().int().min(1).max(64) });
export class PostgresHttpRateCoordinatorError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
export function parsePostgresHttpRateCoordinatorOptions(value) {
    const parsed = postgresHttpRateCoordinatorOptionsSchema.safeParse(value);
    if (!parsed.success || parsed.data.statementTimeoutMs > parsed.data.timeoutMs)
        throw new PostgresHttpRateCoordinatorError('invalid-config');
    let connection;
    try {
        connection = parsePostgresConfiguration({ ...parsed.data.connection, namespace: 'http-rate-coordinator', initialize: false });
    }
    catch {
        throw new PostgresHttpRateCoordinatorError('invalid-config');
    }
    const { host, port, database, user, password, tls } = connection;
    return { ...parsed.data, connection: { host, port, database, user, password, tls } };
}
