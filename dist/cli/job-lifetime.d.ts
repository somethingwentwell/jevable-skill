import { type CliOperations } from './operations.ts';
import type { CliValues } from './runtime.ts';
import { JobLifetime as CliJobLifetime } from '../process/job-lifetime.ts';
export { JobLifetime as CliJobLifetime, JobInterruptedError as CliJobInterruptedError } from '../process/job-lifetime.ts';
/** Validate selection before installing handlers; never acquire shutdown authority over a service. */
export declare function openJobOperations(values: CliValues, lifetime: CliJobLifetime, open?: (values: CliValues) => Promise<CliOperations>): Promise<CliOperations>;
