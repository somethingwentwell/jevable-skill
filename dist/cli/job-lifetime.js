import { openCliOperations, operationSelection } from "./operations.js";
export { JobLifetime as CliJobLifetime, JobInterruptedError as CliJobInterruptedError } from "../process/job-lifetime.js";
/** Validate selection before installing handlers; never acquire shutdown authority over a service. */
export async function openJobOperations(values, lifetime, open = openCliOperations) {
    if (operationSelection(values) !== 'local')
        return open(values);
    const release = lifetime.hold();
    let owner;
    try {
        owner = await open(values);
    }
    catch (error) {
        release();
        throw error;
    }
    let closing;
    return { storage: owner.storage, async call(command, parent) {
            lifetime.assertAdmission();
            return parent === undefined ? owner.call(command) : owner.call(command, parent);
        }, close() {
            // Keep handlers through telemetry/storage cleanup; duplicate close joins the same result.
            return closing ??= (async () => { try {
                await owner.close();
            }
            finally {
                release();
            } })();
        } };
}
