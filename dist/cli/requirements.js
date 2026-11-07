import { z } from 'zod';
export class CliFlagRequirementsError extends Error {
}
const uuid = z.uuid();
function validFormat(format, value) {
    if (typeof value !== 'string')
        return false;
    if (format === 'uuid')
        return value.length === 36 && uuid.safeParse(value).success;
    if (format === 'audit-sequence')
        return value.length <= 19 && /^(0|[1-9][0-9]*)$/u.test(value)
            && BigInt(value) <= 9223372036854775806n;
    return value.length === 64 && /^[a-f0-9]{64}$/u.test(value);
}
export function cliArgumentFormatDescription(format) {
    return format === 'uuid' ? 'a UUID'
        : format === 'sha256' ? 'a 64-character lowercase hexadecimal SHA-256'
            : format === 'docker-id' ? 'a full 64-character lowercase hexadecimal Docker ID'
                : 'a canonical decimal audit sequence from 0 to 9223372036854775806';
}
/** File paths, credential references and template IDs are intentionally not UUIDs. */
export function cliPositionalRequirements(path, count) {
    const identity = /^projects (?!list$|deletions$|create$)/u.test(path)
        || /^releases (?:show|create|export|build-image|export-kubernetes)$/u.test(path)
        || /^tests (?:show|history|erasure-review|erasure|generate|generation|edit|accept|archive|unarchive|run|result)$/u.test(path)
        || /^runs (?!list$|export-bundle$|inspect-bundle$)/u.test(path)
        || /^approvals (?:show|decide|notify (?:prepare|show|abort|automatic-show))$/u.test(path)
        || path === 'import show' || path === 'import export-origin'
        || /^grants (?:show|revoke)$/u.test(path)
        || /^caller (?:read|cancel|checkpoint|control|stream)$/u.test(path)
        || path === 'runtime observe';
    if (identity && count !== 1)
        throw new Error('CLI positional formats do not match the command parser.');
    return identity ? [{ index: 0, format: 'uuid' }] : [];
}
// These are executable admission rules, not a second copy of the parser grammar.
const required = {
    'account prepare': ['issuer', 'session-dir', 'name'],
    'account inspect': ['issuer', 'session-dir'], 'account link': ['issuer', 'session-dir'],
    'account exchange': ['issuer', 'session-dir', 'session-id', 'authorization-sha256', 'confirm-exchange'],
    'account status': ['issuer', 'session-dir', 'session-id', 'authorization-sha256', 'key-id', 'grant-sha256'],
    'account revoke': ['issuer', 'session-dir', 'session-id', 'authorization-sha256', 'key-id', 'grant-sha256', 'confirm-revoke'],
    'grants token': ['id', 'output'], 'grants list': ['page'], 'grants revoke': ['request-id', 'expected-generation'],
    'reviewer decide': ['endpoint', 'token-file', 'instance-id'],
    'caller start': ['endpoint', 'token-file', 'instance-id', 'release-pin-file'],
    'caller read': ['endpoint', 'token-file', 'instance-id', 'release-pin-file'],
    'caller stream': ['endpoint', 'token-file', 'instance-id', 'release-pin-file'],
    'caller cancel': ['endpoint', 'token-file', 'instance-id', 'release-pin-file', 'request-file'],
    'caller checkpoint': ['endpoint', 'token-file', 'instance-id', 'release-pin-file'],
    'caller control': ['endpoint', 'token-file', 'instance-id', 'release-pin-file', 'request-file'],
    run: ['input'],
    'runtime token': ['output'], 'runtime export': ['output'],
    'runtime lock inspect': ['state-dir'], 'runtime lock recover': ['state-dir', 'request-id', 'owner', 'lock-sha256', 'confirm-recover'],
    'runtime lock inspect-recovery': ['state-dir'], 'runtime lock complete-recovery': ['state-dir', 'request-id', 'owner', 'lock-sha256', 'confirm-recover'],
    'skill export': ['output'],
    'runtime serve': ['token-file'], 'runtime status': ['endpoint', 'token-file'],
    'runtime request': ['endpoint', 'token-file'],
    'runtime submit': ['endpoint', 'token-file', 'instance-id'],
    'runtime observe': ['endpoint', 'token-file', 'instance-id'],
    'runtime build-image': ['runtime-sha256', 'base-image', 'platform', 'tag', 'docker-context', 'output'],
    'runtime save-image': ['receipt-sha256', 'output'],
    'runtime export-kubernetes': ['image-receipt', 'receipt-sha256', 'options-file', 'options-sha256', 'output'],
    'runtime inspect': ['runtime', 'owner-file', 'owner-sha256'],
    'runtime stop': ['runtime', 'owner-file', 'owner-sha256', 'container-id'],
    'runtime restart': ['runtime', 'owner-file', 'owner-sha256', 'container-id', 'token-file'],
    'projects create': ['title'], 'projects propose': ['expected-generation', 'file'],
    'projects accept': ['expected-generation', 'proposal-id', 'revision'],
    'projects reject': ['expected-generation', 'proposal-id', 'revision'],
    'projects diff': ['from', 'to'], 'projects rename': ['expected-generation', 'title'],
    'projects archive': ['expected-generation'], 'projects unarchive': ['expected-generation'],
    'projects duplicate': ['expected-generation', 'title', 'revision'],
    'projects delete': ['expected-generation', 'confirm-delete'],
    'projects export': ['expected-generation', 'revision', 'output'],
    'projects restore': ['expected-generation', 'revision'],
    'projects run': ['expected-generation', 'revision', 'input'],
    'releases create': ['expected-generation', 'revision', 'version'],
    'releases export': ['release-sha256', 'format', 'output'],
    'releases build-image': ['release-sha256', 'base-image', 'platform', 'tag', 'docker-context', 'output'],
    'releases save-image': ['receipt-sha256', 'output'],
    'releases export-kubernetes': ['release-sha256', 'image-receipt', 'receipt-sha256', 'options-file', 'options-sha256', 'output'],
    'kubernetes capacity': ['nodes-file', 'pods-file'],
    'telemetry export-gateway': ['options-file', 'options-sha256', 'output'],
    'tests generate': ['id', 'expected-generation', 'revision'],
    'tests edit': ['file', 'expected-generation'], 'tests accept': ['expected-generation', 'sha256'],
    'tests archive': ['expected-generation', 'sha256'], 'tests unarchive': ['expected-generation', 'sha256'],
    'tests run': ['expected-generation', 'sha256', 'id'],
    'tests erase': ['confirm-delete'],
    'tests suite create': ['output'], 'tests suite run': ['suite-sha256'], 'tests suite coverage': ['file'],
    'runs export': ['output'], 'runs export-bundle': ['output'], 'runs cancel': ['request-id'],
    'runs step': ['request-id', 'checkpoint-sha256'], 'runs continue': ['request-id', 'checkpoint-sha256'],
    'runs pause': ['request-id', 'checkpoint-sha256'], 'runs recover': ['request-id', 'checkpoint-sha256'],
    'runs watch': ['endpoint', 'token-file'],
    'approvals list': ['page'], 'approvals decide': ['attempt', 'action'],
    'approvals notify prepare': ['revision', 'attempt', 'destination'], 'approvals notify list': ['page'],
    'approvals notify automatic-list': ['page'],
    'providers set': ['expected-generation'], 'credentials set': ['expected-generation'],
    'templates render': ['output'], 'import project': ['reviewed-sha256'],
    'import vendor': ['file', 'title', 'id', 'reviewed-source-sha256', 'reviewed-conversion-sha256', 'reviewed-revision'],
    'import export-origin': ['reviewed-origin-sha256', 'include-private', 'output'],
};
const present = (flag) => ({ flag, present: true });
const selected = { any: [{ flag: 'runtime', equals: 'docker' }, present('endpoint')] };
/** Rules use only declared parser flags. No filesystem, service or environment discovery. */
export function cliFlagRequirements(path, options, profile = 'command') {
    const rules = [];
    const choices = (flag, values) => {
        if (options[flag] && options[flag] !== 'string')
            throw new Error('CLI choices do not match the command parser.');
        if (options[flag] === 'string')
            rules.push({ kind: 'choices', flag, values: [...values] });
    };
    choices('storage', ['sqlite', 'postgres']);
    choices('runtime-storage', ['sqlite', 'postgres']);
    choices('runtime-rate-coordinator', ['postgres']);
    choices('trigger-mode', ['api']);
    choices('runtime', ['runtime inspect', 'runtime stop', 'runtime restart'].includes(path)
        || path === 'runtime start' && profile.startsWith('docker') ? ['docker']
        : path === 'runtime start' && profile !== 'selection' ? ['local'] : ['local', 'docker']);
    choices('platform', ['linux/arm64', 'linux/amd64']);
    choices('language', ['en', 'zh']);
    if (path === 'projects export')
        choices('format', ['json', 'zip']);
    if (path === 'releases export')
        choices('format', ['zip']);
    if (path === 'approvals notify prepare')
        choices('event-kind', ['requested', 'decided', 'expired', 'cancelled']);
    if (path === 'approvals notify list') {
        choices('event-kind', ['requested', 'decided', 'expired', 'cancelled']);
        choices('outcome', ['pending', 'accepted', 'rejected', 'uncertain']);
    }
    const require = (flags, when) => {
        if (flags.length)
            rules.push({ kind: 'required', flags: [...flags], ...(when ? { when: structuredClone(when) } : {}) });
    };
    const together = (flags) => rules.push({ kind: 'together', flags });
    require(required[path] ?? []);
    if (options.storage && options['database-file'])
        require(['database-file'], { flag: 'storage', equals: 'postgres' });
    if (options.endpoint && options['token-file'])
        require(['token-file'], present('endpoint'));
    if (options['suite-telemetry-file'])
        require(['suite-telemetry-file'], present('suite-telemetry-credential-file'));
    if (options['owner-file'] && options.endpoint)
        require(['owner-file', 'owner-sha256', 'container-id', 'token-file'], { flag: 'runtime', equals: 'docker' });
    if (['run', 'projects run', 'releases create', 'import project'].includes(path))
        require(['id'], selected);
    if (path === 'releases create')
        require(['runtime-storage'], present('runtime-rate-coordinator'));
    if (['runtime inspect', 'runtime stop', 'runtime restart'].includes(path))
        rules.push({ kind: 'fixed', flag: 'runtime', value: 'docker' });
    if (path === 'runtime inspect')
        require(['token-file'], present('ca-file'));
    if (path === 'runtime start') {
        if (profile.startsWith('docker')) {
            require(['runtime', 'image-receipt', 'receipt-sha256', 'owner-file', 'port', 'token-file', 'tls-cert-file', 'tls-key-file']);
            rules.push({ kind: 'fixed', flag: 'runtime', value: 'docker' });
            together(['network', 'network-id']);
            require(['notifications-file'], present('notifications-ca-file'));
            require(['telemetry-file'], { any: [present('telemetry-credential-file'), present('telemetry-ca-file')] });
        }
        else
            require(['token-file']);
    }
    if (path === 'runtime serve' || path === 'runtime start') {
        if (options['rate-coordinator-file'])
            rules.push({ kind: 'exactly-one', flags: ['rate-limits-file', 'rate-coordinator-file'],
                when: { any: [present('rate-limits-file'), present('rate-coordinator-file')] } });
    }
    if (path === 'runtime serve' || path === 'runtime start' && !profile.startsWith('docker')) {
        together(['release-file', 'release-sha256']);
        if (options['webhooks-file'])
            require(['release-file', 'release-sha256', 'async-concurrency'], present('webhooks-file'));
        together(['public-origin', 'tls-cert-file', 'tls-key-file']);
    }
    if (path === 'credentials set')
        rules.push({ kind: 'exactly-one', flags: ['file', 'stdin'] });
    if (path === 'account exchange')
        rules.push({ kind: 'exactly-one', flags: ['code-file', 'code-stdin'] });
    if (path === 'templates render')
        together(['provider', 'model']);
    if (path === 'approvals notify list')
        together(['project-id', 'generation', 'revision']);
    if (path === 'import preview') {
        require(['output'], { flag: 'overwrite', equals: true });
        require(['output'], { flag: 'output-format', equals: 'html' });
        choices('output-format', ['yaml', 'html']);
    }
    if (path === 'projects export' || path === 'releases export') {
        require(['evidence-file', 'evidence-sha256'], { any: [present('evidence-file'), present('evidence-sha256'), present('include-private-evidence')] });
    }
    if (path === 'preview') {
        rules.push({ kind: 'exactly-one', flags: ['output', 'serve'] });
        require(['output'], { flag: 'overwrite', equals: true });
        rules.push({ kind: 'exactly-one', flags: ['token-file', 'token-env'], when: { flag: 'serve', equals: true } });
        together(['project-pin-file', 'project-pin-sha256']);
        rules.push({ kind: 'exactly-one', flags: ['project-id', 'project-pin-file'], when: { any: [{ flag: 'runtime', equals: 'docker' }, present('endpoint'), { flag: 'storage', equals: 'postgres' }] } });
        require(['preview-token-file'], { any: [{ flag: 'runtime', equals: 'docker' }, present('endpoint')] });
    }
    const integer = (flag, minimum, maximum, defaultValue) => {
        if (options[flag] && options[flag] !== 'string')
            throw new Error('CLI integer bounds do not match the command parser.');
        if (options[flag] === 'string')
            rules.push({ kind: 'integer', flag, minimum, maximum, encoding: 'canonical-unsigned-decimal',
                ...(defaultValue === undefined ? {} : { defaultValue }) });
    };
    integer('expected-generation', ['providers set', 'credentials set'].includes(path) ? 0 : 1, path === 'grants revoke' ? 1 : Number.MAX_SAFE_INTEGER);
    integer('generation', 1, Number.MAX_SAFE_INTEGER);
    integer('limit', 1, path === 'tests generate' ? 32 : 200, path === 'tests generate' ? 12 : 100);
    integer('port', path === 'runtime start' && profile.startsWith('docker') ? 1024 : 0, 65535, path === 'runtime start' && profile.startsWith('docker') ? undefined : 0);
    integer('drain-wait-ms', 1, 60000, 5000);
    integer('async-concurrency', 1, 64);
    integer('memory-mb', 128, 65536, 512);
    integer('cpus', 1, 64, 1);
    integer('wait-ms', 0, 60000, 10000);
    integer('timeout-ms', 1, path.startsWith('account ') ? 60000 : path === 'doctor' ? 30000 : 3600000, path.startsWith('account ') ? 10000 : path === 'doctor' ? 3000 : 30000);
    integer('interval-ms', 100, 60000, 1000);
    integer('duration-ms', 1, path === 'caller stream' ? 60000 : 3600000, path === 'caller stream' ? 15000 : 60000);
    const format = (flag, format) => {
        if (options[flag] && options[flag] !== 'string')
            throw new Error('CLI argument formats do not match the command parser.');
        if (options[flag] === 'string')
            rules.push({ kind: 'format', flag, format });
    };
    for (const flag of ['id', 'new-id', 'proposal-id', 'project-id', 'request-id', 'attempt', 'instance-id', 'confirm-delete', 'session-id', 'key-id', 'confirm-revoke', 'owner'])
        format(flag, 'uuid');
    for (const flag of ['revision', 'from', 'to', 'sha256', 'release-sha256', 'runtime-sha256', 'receipt-sha256',
        'owner-sha256', 'checkpoint-sha256', 'project-pin-sha256', 'reviewed-sha256', 'evidence-sha256', 'options-sha256', 'suite-sha256',
        'reviewed-source-sha256', 'reviewed-conversion-sha256', 'reviewed-revision', 'reviewed-origin-sha256', 'authorization-sha256', 'grant-sha256', 'lock-sha256'])
        format(flag, 'sha256');
    for (const flag of ['container-id', 'network-id'])
        format(flag, 'docker-id');
    format('after', path === 'providers audit' ? 'audit-sequence' : 'uuid');
    // Developer drift fails closed instead of publishing a requirement for an unknown flag.
    const conditionFlags = (condition) => 'any' in condition
        ? condition.any.flatMap(conditionFlags) : [condition.flag];
    for (const rule of rules)
        for (const flag of 'flag' in rule ? [rule.flag]
            : [...rule.flags, ...(rule.when ? conditionFlags(rule.when) : [])]) {
            if (!options[flag])
                throw new Error('CLI requirements do not match the command parser.');
        }
    return { scope: 'flag-presence, finite choices, integer bounds and argument formats; file schemas, combinations, review and authority still apply', rules };
}
function matches(condition, values) {
    if ('any' in condition)
        return condition.any.some(item => matches(item, values));
    return condition.present ? values[condition.flag] !== undefined : values[condition.flag] === condition.equals;
}
export function validateCliFlagRequirements(path, values, options, positionals) {
    const profile = path === 'runtime start' ? values.runtime === 'docker' ? 'docker'
        : values.runtime === undefined || values.runtime === 'local' ? 'command' : 'selection' : 'command';
    const { rules } = cliFlagRequirements(path, options, profile);
    const supplied = (flag) => options[flag] === 'boolean' ? values[flag] === true : typeof values[flag] === 'string' && values[flag].length > 0;
    for (const rule of rules) {
        if (rule.kind === 'format') {
            if (values[rule.flag] !== undefined && !validFormat(rule.format, values[rule.flag]))
                throw new CliFlagRequirementsError(`Use --${rule.flag} ${cliArgumentFormatDescription(rule.format)}.`);
            continue;
        }
        if (rule.kind === 'integer') {
            const value = values[rule.flag];
            if (value !== undefined && (typeof value !== 'string' || value.length > 16 || !/^(0|[1-9][0-9]*)$/u.test(value)
                || !Number.isSafeInteger(Number(value)) || Number(value) < rule.minimum || Number(value) > rule.maximum))
                throw new CliFlagRequirementsError(`Use --${rule.flag} a canonical decimal integer from ${rule.minimum} to ${rule.maximum}.`);
            continue;
        }
        if (rule.kind === 'choices') {
            const value = values[rule.flag];
            if (value !== undefined && (typeof value !== 'string' || !rule.values.includes(value)))
                throw new CliFlagRequirementsError(`Use --${rule.flag} ${rule.values.join('|')}.`);
            continue;
        }
        if (rule.kind === 'fixed') {
            if (values[rule.flag] !== rule.value)
                throw new CliFlagRequirementsError(`Use --${rule.flag} ${rule.value}; no fallback was attempted.`);
            continue;
        }
        if (rule.when && !matches(rule.when, values))
            continue;
        if (rule.kind === 'required')
            for (const flag of rule.flags) {
                if (!supplied(flag))
                    throw new CliFlagRequirementsError(`Provide --${flag}.`);
            }
        if (rule.kind === 'together' && rule.flags.some(flag => values[flag] !== undefined) && !rule.flags.every(supplied))
            throw new CliFlagRequirementsError(`Provide ${rule.flags.map(flag => `--${flag}`).join(' and ')} together.`);
        if (rule.kind === 'exactly-one' && rule.flags.filter(supplied).length !== 1)
            throw new CliFlagRequirementsError(`Choose exactly one of ${rule.flags.map(flag => `--${flag}`).join(' or ')}.`);
    }
    if (positionals)
        for (const rule of cliPositionalRequirements(path, positionals.length)) {
            if (!validFormat(rule.format, positionals[rule.index]))
                throw new CliFlagRequirementsError(`Use positional argument ${rule.index + 1} ${cliArgumentFormatDescription(rule.format)}.`);
        }
}
