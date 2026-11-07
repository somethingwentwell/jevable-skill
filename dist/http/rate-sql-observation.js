import { types } from 'node:util';
export const HTTP_RATE_SQL_OPERATIONS = ['begin', 'lock', 'debit', 'commit', 'rollback'];
function containPromise(value) {
    if (!types.isPromise(value))
        return false;
    Promise.prototype.then.call(value, undefined, () => { });
    return true;
}
export function beginHttpRateSqlObservation(observer, operation) {
    try {
        const observation = observer?.(operation);
        return containPromise(observation) ? undefined : observation;
    }
    catch {
        return undefined;
    }
}
export function endHttpRateSqlObservation(observation, outcome) {
    try {
        containPromise(observation?.end(outcome));
    }
    catch { /* Preserve original SQL result/error; no retry or refund. */ }
}
