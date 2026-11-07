import { z } from 'zod';
import { RuntimeHttpError } from "../http/client.js";
import { createOperationTestSuiteHost } from "./operation-host.js";
import { PROTOCOL_VERSION } from "../capabilities.js";
/** Client-side orchestration over existing guarded owner operations; no new execution endpoint. */
export function createHttpTestSuiteHost(client, traceContext, telemetry) {
    let instanceId;
    let initialized;
    const initialize = () => initialized ??= (async () => {
        const capabilities = z.object({ instanceId: z.uuid(), api: z.object({ protocol: z.literal(PROTOCOL_VERSION) }) })
            .safeParse(await client.capabilities());
        if (!capabilities.success)
            throw new RuntimeHttpError('invalid-response');
        client.pinInstance(capabilities.data.instanceId);
        instanceId = capabilities.data.instanceId;
    })();
    const call = async (command, context) => {
        // Bootstrap is read-only and shared by concurrent callers. Its immutable pin
        // is sent before any operation, so a replacement rejects before mutation.
        // A failed handshake poisons this host; do not discover/retry another owner.
        await initialize();
        const parsed = z.object({ schemaVersion: z.literal(1), instanceId: z.uuid(), result: z.unknown() }).safeParse(await client.operation(command, context));
        if (!parsed.success)
            throw new RuntimeHttpError('invalid-response');
        if (instanceId && instanceId !== parsed.data.instanceId)
            throw new RuntimeHttpError('conflict');
        instanceId = parsed.data.instanceId;
        return parsed.data.result;
    };
    return createOperationTestSuiteHost({ call }, traceContext, telemetry);
}
