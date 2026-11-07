import { z } from 'zod';
import { WorkflowRuntimeError } from "../runtime/errors.js";
import { notificationEndpointSchema, notificationSha256 } from "./schema.js";
import { automaticApprovalPolicySchema, parseAutomaticApprovalPolicy } from "./automatic-policy.js";
const automaticSchema = z.strictObject({
    policy: automaticApprovalPolicySchema,
    reviewedPolicySha256: z.string().regex(/^[a-f0-9]{64}$/u),
    maxPending: z.number().int().min(1).max(64).default(16),
    maxAdmissions: z.number().int().min(1).max(100000).default(10000),
    maxEvents: z.number().int().min(2).max(200000).default(20000),
});
const configSchema = z.strictObject({
    endpoints: z.array(notificationEndpointSchema).max(32).default([]),
    maxInFlight: z.number().int().min(1).max(64).default(16),
    maxDeliveries: z.number().int().min(1).max(100000).default(10000),
    maxEvents: z.number().int().min(2).max(200000).default(20000),
    automatic: automaticSchema.optional(),
}).refine(value => new Set(value.endpoints.map(endpoint => endpoint.id)).size === value.endpoints.length)
    .refine(value => {
    if (!value.automatic)
        return true;
    try {
        const { automatic } = value, policy = parseAutomaticApprovalPolicy(automatic.policy);
        return notificationSha256(policy) === automatic.reviewedPolicySha256
            && automatic.maxPending <= value.maxInFlight && automatic.maxAdmissions * 2 <= automatic.maxEvents
            && policy.routes.every(route => value.endpoints.some(endpoint => endpoint.id === route.endpointId
                && notificationSha256(endpoint) === route.endpointSha256));
    }
    catch {
        return false;
    }
});
export { configSchema as notificationConfigSchema };
export function parseNotificationConfig(value) {
    const parsed = configSchema.safeParse(value);
    if (!parsed.success)
        throw new WorkflowRuntimeError('invalid-command');
    const config = parsed.data;
    return config.automatic ? { ...config, automatic: { ...config.automatic,
            policy: parseAutomaticApprovalPolicy(config.automatic.policy) } } : config;
}
