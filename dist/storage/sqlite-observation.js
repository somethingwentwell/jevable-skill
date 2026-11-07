/** Wrap only this owner's connection; never patch native prototypes or install ambient instrumentation. */
export function observeSQLiteDatabase(database, statistics, clock = () => performance.now()) {
    const invalidate = () => { try {
        statistics.invalidate();
    }
    catch { /* Diagnostics cannot affect the native call. */ } };
    function observe(method, work) {
        let started, returned = false;
        try {
            started = clock();
        }
        catch {
            invalidate();
        }
        try {
            const result = work();
            returned = true;
            return result;
        }
        finally {
            if (started !== undefined) {
                try {
                    statistics.record(method, returned ? 'returned' : 'threw', (clock() - started) / 1000);
                }
                catch {
                    invalidate();
                }
            }
        }
    }
    function iterator(native) {
        const methods = new Map();
        let proxy;
        proxy = new Proxy(native, { get(target, key) {
                if (key === Symbol.iterator)
                    return () => proxy;
                const value = Reflect.get(target, key, target);
                if (typeof value !== 'function')
                    return value;
                if (!methods.has(key))
                    methods.set(key, key === 'next' || key === 'return'
                        ? (...args) => observe(key === 'next' ? 'iterator.next' : 'iterator.return', () => Reflect.apply(value, target, args))
                        : value.bind(target));
                return methods.get(key);
            } });
        return proxy;
    }
    function statement(native) {
        const methods = new Map();
        return new Proxy(native, { get(target, key) {
                const value = Reflect.get(target, key, target);
                if (typeof value !== 'function')
                    return value;
                if (!methods.has(key))
                    methods.set(key, key === 'iterate'
                        ? (...args) => iterator(observe('iterate', () => Reflect.apply(value, target, args)))
                        : key === 'all' || key === 'get' || key === 'run'
                            ? (...args) => observe(key, () => Reflect.apply(value, target, args))
                            : value.bind(target));
                return methods.get(key);
            } });
    }
    const methods = new Map();
    return new Proxy(database, { get(target, key) {
            const value = Reflect.get(target, key, target);
            if (typeof value !== 'function')
                return value;
            if (!methods.has(key))
                methods.set(key, key === 'prepare'
                    ? (...args) => statement(observe('prepare', () => Reflect.apply(value, target, args)))
                    : key === 'exec' ? (...args) => observe('exec', () => Reflect.apply(value, target, args))
                        : value.bind(target));
            return methods.get(key);
        } });
}
