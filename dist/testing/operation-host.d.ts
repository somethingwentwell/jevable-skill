import { type RuntimeTraceContext } from '../http/client.ts';
import type { RuntimeOperation } from '../http/operations.ts';
import type { TestSuiteHost } from './suite.ts';
import type { TestSuiteTelemetry } from './telemetry.ts';
type SuiteOperation = Extract<RuntimeOperation, {
    operation: 'tests.result' | 'tests.show' | 'projects.show' | 'tests.run';
}>;
export interface TestSuiteOperationClient {
    call(command: SuiteOperation, context?: RuntimeTraceContext): Promise<unknown>;
}
/** Existing pinned operation client supplies transport/authority; this host never creates or owns a service. */
export declare function createOperationTestSuiteHost(client: TestSuiteOperationClient, traceContext?: RuntimeTraceContext, telemetry?: TestSuiteTelemetry): TestSuiteHost;
export {};
