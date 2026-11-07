import { types } from 'node:util';
function containAsyncReturn(value) {
    if (!types.isPromise(value))
        return false;
    Promise.prototype.then.call(value, undefined, () => { });
    return true;
}
export function beginTransactionObservation(observer, kind) {
    try {
        const observation = observer?.(kind);
        // Invalid asynchronous hooks never delay admission; contain native rejected promises,
        // including cross-realm promises, without assimilating arbitrary thenables.
        if (containAsyncReturn(observation))
            return undefined;
        return observation;
    }
    catch {
        return undefined;
    }
}
export function endTransactionObservation(observation, outcome) {
    try {
        containAsyncReturn(observation?.end(outcome));
    }
    catch { /* Optional diagnostics cannot replace journal results/errors or retry work. */ }
}
