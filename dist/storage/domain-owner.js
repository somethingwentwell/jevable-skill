import { QueueOccupancy } from "./queue-occupancy.js";
const operations = new WeakMap();
const occupancy = new WeakMap();
/** Synchronous metadata projection; never enters the domain gate or queries storage. */
export function domainQueueOccupancy(journal) {
    return occupancy.get(journal)?.snapshot() ?? { waiting: 0, active: 0 };
}
/** Serialize domain read/guard/write operations on one owner; never nest this gate or perform external effects inside it. */
export function withDomainWrite(journal, work) {
    let queue = occupancy.get(journal);
    if (!queue) {
        queue = new QueueOccupancy();
        occupancy.set(journal, queue);
    }
    const observation = queue.admit();
    const pending = (operations.get(journal) ?? Promise.resolve()).then(async () => {
        observation.begin();
        try {
            journal.signal.throwIfAborted();
            return await work();
        }
        finally {
            observation.end();
        }
    });
    operations.set(journal, pending.then(() => { }, () => { }));
    return pending;
}
