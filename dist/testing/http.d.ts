import { type RuntimeClient, type RuntimeTraceContext } from '../http/client.ts';
import type { TestSuiteTelemetry } from './telemetry.ts';
import type { TestSuiteHost } from './suite.ts';
/** Client-side orchestration over existing guarded owner operations; no new execution endpoint. */
export declare function createHttpTestSuiteHost(client: RuntimeClient, traceContext?: RuntimeTraceContext, telemetry?: TestSuiteTelemetry): TestSuiteHost;
