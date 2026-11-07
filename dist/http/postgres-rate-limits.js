import Client from 'pg/lib/client.js';
import { checkServerIdentity } from 'node:tls';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { httpRateLimitsSchema } from "./rate-limits.js";
import { parsePostgresHttpRateCoordinatorOptions, PostgresHttpRateCoordinatorError } from "./postgres-rate-config.js";
export { PostgresHttpRateCoordinatorError } from "./postgres-rate-config.js";
import { beginHttpRateSqlObservation, endHttpRateSqlObservation } from "./rate-sql-observation.js";
const debitSchema = z.strictObject({ requestId: z.uuid(), scope: z.uuid(), policySha256: z.string().regex(/^[a-f0-9]{64}$/u),
    lane: z.enum(['requests', 'controls']), policy: httpRateLimitsSchema });
const integer = z.string().regex(/^(0|[1-9][0-9]{0,18})$/u);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const lock = createHash('sha256').update('jevable-http-rate/schema/v1').digest().readBigInt64BE().toString();
/** One explicitly owned database session; independent hosts share only the provisioned scope row.
 * No workflow journal lock, connection pool, discovery, reconnect, retry or per-attempt history.
 */
export class PostgresHttpRateCoordinator {
    client;
    options;
    state = 'opening';
    tail = Promise.resolve();
    pending = 0;
    ending;
    closing;
    canonicalPolicy;
    policySha256;
    constructor(client, options) {
        this.client = client;
        this.options = options;
        this.canonicalPolicy = JSON.stringify(options.policy);
        this.policySha256 = hash(this.canonicalPolicy);
        client.on('error', () => this.lose());
        client.on('end', () => { if (this.state !== 'closing' && this.state !== 'closed')
            this.lose(); });
    }
    /** Explicit operator initialization or runtime attach; attaching never resets balances. */
    static async open(value) {
        const { connection, ...policy } = parsePostgresHttpRateCoordinatorOptions(value);
        const ca = connection.tls.mode === 'verify-full' ? connection.tls.ca : undefined;
        const client = new Client({ host: connection.host, port: connection.port, database: connection.database,
            user: connection.user, password: connection.password, application_name: 'jevable-http-rate/v1', client_encoding: 'UTF8',
            options: '-c search_path=pg_catalog', sslnegotiation: 'postgres',
            ssl: connection.tls.mode === 'loopback-test' ? false : { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(ca ? { ca } : {}),
                checkServerIdentity: (_hostname, certificate) => checkServerIdentity(connection.host, certificate) },
            connectionTimeoutMillis: policy.timeoutMs, statement_timeout: policy.statementTimeoutMs,
            query_timeout: policy.statementTimeoutMs + 1000, idle_in_transaction_session_timeout: policy.timeoutMs + 2000,
            keepAlive: true, keepAliveInitialDelayMillis: 5000 });
        const coordinator = new PostgresHttpRateCoordinator(client, policy);
        let transaction = false, commitStarted = false;
        try {
            await client.connect();
            const version = await client.query('SHOW server_version_num');
            if (Math.floor(Number(version.rows[0]?.server_version_num) / 10000) !== 17)
                throw new PostgresHttpRateCoordinatorError('version-mismatch');
            transaction = true;
            await client.query('BEGIN');
            if (policy.initialize) {
                await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lock]);
                await client.query(`CREATE SCHEMA IF NOT EXISTS jevable_http_rate;
          CREATE TABLE IF NOT EXISTS jevable_http_rate.scopes (
            scope UUID PRIMARY KEY, format TEXT NOT NULL, version INTEGER NOT NULL,
            policy_sha256 TEXT NOT NULL CHECK(policy_sha256~'^[a-f0-9]{64}$'), policy TEXT NOT NULL CHECK(octet_length(policy)<=4096),
            requests_units BIGINT NOT NULL CHECK(requests_units>=0), controls_units BIGINT NOT NULL CHECK(controls_units>=0),
            at_ms BIGINT NOT NULL CHECK(at_ms>=0));`);
                await client.query(`INSERT INTO jevable_http_rate.scopes(scope,format,version,policy_sha256,policy,requests_units,controls_units,at_ms)
          VALUES($1,'jevable.http-rate/v1',1,$2,$3,$4,$5,floor(extract(epoch from clock_timestamp())*1000)::bigint)
          ON CONFLICT DO NOTHING`, [policy.scope, coordinator.policySha256, coordinator.canonicalPolicy,
                    policy.policy.requests.capacity * policy.policy.requests.refillIntervalMs,
                    policy.policy.controls.capacity * policy.policy.controls.refillIntervalMs]);
            }
            else {
                const table = await client.query("SELECT to_regclass('jevable_http_rate.scopes') AS present");
                if (!table.rows[0]?.present)
                    throw new PostgresHttpRateCoordinatorError('uninitialized');
            }
            await coordinator.readLockedScope();
            commitStarted = true;
            await client.query('COMMIT');
            transaction = false;
            if (coordinator.state === 'lost')
                throw new PostgresHttpRateCoordinatorError('unavailable');
            coordinator.state = 'open';
            return coordinator;
        }
        catch (error) {
            if (transaction && !commitStarted)
                await client.query('ROLLBACK').catch(() => coordinator.lose());
            await coordinator.close();
            throw commitStarted && transaction ? new PostgresHttpRateCoordinatorError('commit-uncertain')
                : error instanceof PostgresHttpRateCoordinatorError ? error : new PostgresHttpRateCoordinatorError('unavailable');
        }
    }
    /** Metadata only, no query, account identity or balance disclosure. */
    status() {
        return { state: this.state, scope: this.options.scope, policySha256: this.policySha256,
            pendingDebits: this.pending, maxPendingDebits: this.options.maxPendingDebits };
    }
    /** Detached pinned HTTP configuration. Closing an HTTP server does not close this owner. */
    admission() {
        return { scope: this.options.scope, policy: structuredClone(this.options.policy), timeoutMs: this.options.timeoutMs,
            consume: this.consume.bind(this) };
    }
    lose() {
        if (this.state === 'closed' || this.state === 'lost')
            return;
        this.state = 'lost';
        this.ending ??= this.client.end().catch(() => { });
    }
    async readLockedScope(query = (text, values) => this.client.query(text, values)) {
        const result = await query(`SELECT CASE WHEN octet_length(format)<=64 THEN format END AS format,version,
      CASE WHEN octet_length(policy_sha256)=64 THEN policy_sha256 END AS policy_sha256,
      CASE WHEN octet_length(policy)<=4096 THEN policy END AS policy,
      requests_units::text,controls_units::text,at_ms::text FROM jevable_http_rate.scopes WHERE scope=$1 FOR UPDATE`, [this.options.scope]);
        const row = result.rows[0];
        if (!row)
            throw new PostgresHttpRateCoordinatorError('uninitialized');
        if (result.rows.length !== 1 || row.format !== 'jevable.http-rate/v1' || row.version !== 1)
            throw new PostgresHttpRateCoordinatorError('version-mismatch');
        if (row.policy_sha256 !== this.policySha256 || row.policy !== this.canonicalPolicy)
            throw new PostgresHttpRateCoordinatorError('policy-conflict');
        for (const [field, max] of [['requests_units', this.options.policy.requests.capacity * this.options.policy.requests.refillIntervalMs],
            ['controls_units', this.options.policy.controls.capacity * this.options.policy.controls.refillIntervalMs], ['at_ms', 9223372036854775807n]]) {
            const value = integer.safeParse(row[field]);
            if (!value.success || BigInt(value.data) > BigInt(max))
                throw new PostgresHttpRateCoordinatorError('corrupt');
        }
    }
    /** Non-idempotent quota attempt: never retry an uncertain call, including with the same requestId. */
    async consume(value, signal, observeSql) {
        const parsed = debitSchema.safeParse(value);
        if (!parsed.success || !(signal instanceof AbortSignal))
            throw new PostgresHttpRateCoordinatorError('invalid-command');
        const request = parsed.data;
        if (request.scope !== this.options.scope || request.policySha256 !== this.policySha256
            || JSON.stringify(request.policy) !== this.canonicalPolicy)
            throw new PostgresHttpRateCoordinatorError('policy-conflict');
        if (signal.aborted)
            throw new PostgresHttpRateCoordinatorError('aborted');
        if (this.state !== 'open')
            throw new PostgresHttpRateCoordinatorError(this.state === 'lost' ? 'unavailable' : 'closed');
        if (this.pending >= this.options.maxPendingDebits)
            throw new PostgresHttpRateCoordinatorError('capacity');
        const deadline = performance.now() + this.options.timeoutMs;
        this.pending++;
        const result = this.tail.then(async () => {
            if (this.state !== 'open')
                throw new PostgresHttpRateCoordinatorError(this.state === 'lost' ? 'unavailable' : 'closed');
            const check = () => {
                if (signal.aborted || performance.now() >= deadline)
                    throw new PostgresHttpRateCoordinatorError('aborted');
                if (this.state === 'lost' || this.state === 'closed')
                    throw new PostgresHttpRateCoordinatorError('unavailable');
            };
            let transaction = false, commitStarted = false;
            const query = async (operation, text, values) => {
                const observation = beginHttpRateSqlObservation(observeSql, operation);
                try {
                    const result = await this.client.query(text, values);
                    endHttpRateSqlObservation(observation, 'acknowledged');
                    return result;
                }
                catch (error) {
                    endHttpRateSqlObservation(observation, operation === 'commit' ? 'uncertain' : 'failed');
                    throw error;
                }
            };
            try {
                check();
                transaction = true;
                await query('begin', 'BEGIN');
                check();
                await this.readLockedScope((text, values) => query('lock', text, values));
                check();
                const r = this.options.policy.requests, c = this.options.policy.controls;
                // Locked first, then acquire database time. Integer units avoid fractional rounding:
                // one token costs refillIntervalMs units, and one elapsed millisecond adds refillTokens.
                const debit = await query('debit', `WITH instant AS MATERIALIZED (
            SELECT scope,requests_units,controls_units,at_ms,
              GREATEST(at_ms,floor(extract(epoch from clock_timestamp())*1000)::bigint) AS now_ms
              FROM jevable_http_rate.scopes WHERE scope=$1),
          refilled AS MATERIALIZED (
            SELECT scope,now_ms,
              LEAST($2::numeric,requests_units::numeric+(now_ms-at_ms)::numeric*$3::numeric)::bigint AS r,
              LEAST($4::numeric,controls_units::numeric+(now_ms-at_ms)::numeric*$5::numeric)::bigint AS c FROM instant),
          decision AS MATERIALIZED (
            SELECT *,CASE WHEN $6::text='requests' THEN r ELSE c END AS available,
              CASE WHEN $6::text='requests' THEN $7::bigint ELSE $8::bigint END AS cost,
              CASE WHEN $6::text='requests' THEN $3::bigint ELSE $5::bigint END AS refill FROM refilled),
          verdict AS MATERIALIZED (SELECT *,available>=cost AS admitted FROM decision)
          UPDATE jevable_http_rate.scopes s SET
            requests_units=v.r-CASE WHEN v.admitted AND $6::text='requests' THEN v.cost ELSE 0 END,
            controls_units=v.c-CASE WHEN v.admitted AND $6::text='controls' THEN v.cost ELSE 0 END,at_ms=v.now_ms
            FROM verdict v WHERE s.scope=v.scope RETURNING v.admitted,
              CASE WHEN v.admitted THEN 0 ELSE GREATEST(1,ceil((v.cost-v.available)::numeric/(v.refill::numeric*1000)))::int END AS retry_after`, [this.options.scope, r.capacity * r.refillIntervalMs, r.refillTokens, c.capacity * c.refillIntervalMs, c.refillTokens,
                    request.lane, r.refillIntervalMs, c.refillIntervalMs]);
                const row = debit.rows[0];
                if (debit.rows.length !== 1 || typeof row?.admitted !== 'boolean' || !Number.isSafeInteger(row.retry_after)
                    || (row.admitted ? row.retry_after !== 0 : row.retry_after < 1 || row.retry_after > 3600))
                    throw new PostgresHttpRateCoordinatorError('corrupt');
                check();
                commitStarted = true;
                await query('commit', 'COMMIT');
                transaction = false;
                check();
                const { requestId, scope, policySha256, lane } = request, bound = { requestId, scope, policySha256, lane };
                return row.admitted ? { ...bound, admitted: true }
                    : { ...bound, admitted: false, retryAfterSeconds: row.retry_after };
            }
            catch (error) {
                if (transaction && commitStarted) {
                    this.lose();
                    throw new PostgresHttpRateCoordinatorError('commit-uncertain');
                }
                if (transaction)
                    await query('rollback', 'ROLLBACK').catch(() => this.lose());
                throw error instanceof PostgresHttpRateCoordinatorError ? error : new PostgresHttpRateCoordinatorError('unavailable');
            }
        });
        this.tail = result.then(() => { }, () => { });
        try {
            return await result;
        }
        finally {
            this.pending--;
        }
    }
    /** Seal admission, refuse queued work, settle active SQL and end this session; no database deletion. */
    close() {
        if (!this.closing) {
            if (this.state !== 'lost')
                this.state = 'closing';
            this.closing = (async () => {
                await this.tail;
                this.ending ??= this.client.end().catch(() => { });
                await this.ending;
                this.state = 'closed';
            })();
        }
        return this.closing;
    }
}
