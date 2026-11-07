import { PostgresRunReader } from "../runtime/postgres-reader.js";
import { PostgresReleaseStore } from "../releases/postgres-store.js";
import { PostgresTestStore } from "../testing/postgres-store.js";
import { WorkflowRuntimeError } from "../runtime/errors.js";
/** Internal guard: caller owns the domain queue until its deletion commits. No external effects or nested gate. */
export async function requireUnreferencedProject(journal, id, limits, maxRecordBytes) {
    const runs = new PostgresRunReader(journal, limits, maxRecordBytes);
    const releases = new PostgresReleaseStore(journal, maxRecordBytes);
    const tests = new PostgresTestStore(journal, limits, maxRecordBytes);
    const scans = [
        { collection: 'runs', capacity: 100000, references: async (key) => (await runs.read(key)).record.project?.id === id },
        { collection: 'releases', capacity: 10000, references: async (key) => (await releases.get(key)).snapshot.project.id === id },
        // Validate every historical definition, including older generations of the same project.
        { collection: 'test-cases', capacity: 10000, references: async (key) => (await tests.history(key)).versions.some(version => version.definition.project.id === id) },
        { collection: 'test-generations', capacity: 10000, references: async (key) => (await tests.generation(key)).snapshot.request.project.id === id },
        { collection: 'test-erasures', capacity: 10000, references: async (key) => (await tests.erasureRecord(key)).project.id === id },
    ];
    for (const scan of scans) {
        if (await journal.count(scan.collection) > scan.capacity)
            throw new WorkflowRuntimeError('limit');
        let after, count = 0;
        do {
            const page = await journal.page(scan.collection, after);
            for (const row of page.records) {
                if (++count > scan.capacity)
                    throw new WorkflowRuntimeError('limit');
                if (await scan.references(row.key))
                    throw new WorkflowRuntimeError('referenced');
            }
            after = page.nextCursor ?? undefined;
        } while (after !== undefined);
    }
}
