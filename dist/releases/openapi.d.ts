type Schema = Record<string, any>;
/** Static contract for the pinned owner API, with examples that never contain
 * a real token or release identity. Generated operation variants track Zod.
 */
export declare function releaseOpenApi(reviewerDecisions?: boolean): {
    openapi: string;
    info: {
        title: string;
        version: string;
        description: string;
    };
    servers: {
        url: string;
        description: string;
    }[];
    security: {
        ownerBearer: never[];
    }[];
    paths: {
        '/review'?: {
            get: {
                summary: string;
                security: never[];
                responses: {
                    '200': {
                        description: string;
                    };
                };
            };
        };
        '/v1/reviewer/request'?: {
            post: {
                summary: string;
                security: {
                    reviewerBearer: never[];
                }[];
                parameters: ({
                    name: string;
                    in: string;
                    required: boolean;
                    schema: {
                        type: string;
                        const: string;
                    };
                    description: string;
                } | {
                    name: string;
                    in: string;
                    required: boolean;
                    schema: {
                        type: string;
                        format: string;
                    };
                })[];
                requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                type: string;
                                additionalProperties: boolean;
                                properties: {};
                            };
                        };
                    };
                };
                responses: {
                    '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    type: string;
                                };
                            };
                        };
                    };
                    '401': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    type: string;
                                    required: string[];
                                    properties: {
                                        status: {
                                            const: string;
                                        };
                                        code: {
                                            type: string;
                                        };
                                    };
                                };
                            };
                        };
                    };
                    '404': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    type: string;
                                    required: string[];
                                    properties: {
                                        status: {
                                            const: string;
                                        };
                                        code: {
                                            type: string;
                                        };
                                    };
                                };
                            };
                        };
                    };
                    '409': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    type: string;
                                    required: string[];
                                    properties: {
                                        status: {
                                            const: string;
                                        };
                                        code: {
                                            type: string;
                                        };
                                    };
                                };
                            };
                        };
                    };
                };
            };
        };
        '/v1/reviewer/decisions'?: {
            post: {
                summary: string;
                security: {
                    reviewerBearer: never[];
                }[];
                parameters: ({
                    name: string;
                    in: string;
                    required: boolean;
                    schema: {
                        type: string;
                        const: string;
                    };
                    description: string;
                } | {
                    name: string;
                    in: string;
                    required: boolean;
                    schema: {
                        type: string;
                        format: string;
                    };
                })[];
                requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                type: string;
                                additionalProperties: boolean;
                                required: string[];
                                properties: {
                                    requestId: {
                                        type: string;
                                        format: string;
                                    };
                                    action: {
                                        type: string;
                                        pattern: string;
                                        description: string;
                                    };
                                    pauseAfter: {
                                        type: string;
                                    };
                                };
                            };
                        };
                    };
                };
                responses: {
                    '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    type: string;
                                };
                            };
                        };
                    };
                    '401': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    type: string;
                                    required: string[];
                                    properties: {
                                        status: {
                                            const: string;
                                        };
                                        code: {
                                            type: string;
                                        };
                                    };
                                };
                            };
                        };
                    };
                    '404': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    type: string;
                                    required: string[];
                                    properties: {
                                        status: {
                                            const: string;
                                        };
                                        code: {
                                            type: string;
                                        };
                                    };
                                };
                            };
                        };
                    };
                    '409': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    type: string;
                                    required: string[];
                                    properties: {
                                        status: {
                                            const: string;
                                        };
                                        code: {
                                            type: string;
                                        };
                                    };
                                };
                            };
                        };
                    };
                };
            };
        };
        '/': {
            get: {
                summary: string;
                security: never[];
                responses: {
                    '200': {
                        description: string;
                    };
                };
            };
        };
        '/v1/openapi.json': {
            get: {
                summary: string;
                responses: {
                    '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    type: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        '/v1/capabilities': {
            get: {
                summary: string;
                responses: {
                    '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    type: string;
                                };
                            };
                        };
                    };
                    '401': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    type: string;
                                    required: string[];
                                    properties: {
                                        status: {
                                            const: string;
                                        };
                                        code: {
                                            type: string;
                                        };
                                    };
                                };
                            };
                        };
                    };
                };
            };
        };
        '/v1/health': {
            get: {
                summary: string;
                parameters: {
                    name: string;
                    in: string;
                    required: boolean;
                    schema: {
                        type: string;
                        const: string;
                    };
                    description: string;
                }[];
                responses: {
                    '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    type: string;
                                };
                            };
                        };
                    };
                    '401': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    type: string;
                                    required: string[];
                                    properties: {
                                        status: {
                                            const: string;
                                        };
                                        code: {
                                            type: string;
                                        };
                                    };
                                };
                            };
                        };
                    };
                    '409': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    type: string;
                                    required: string[];
                                    properties: {
                                        status: {
                                            const: string;
                                        };
                                        code: {
                                            type: string;
                                        };
                                    };
                                };
                            };
                        };
                    };
                };
            };
        };
        '/v1/operations': {
            post: {
                summary: string;
                parameters: {
                    name: string;
                    in: string;
                    required: boolean;
                    schema: {
                        type: string;
                        const: string;
                    };
                    description: string;
                }[];
                description: string;
                requestBody: {
                    required: boolean;
                    content: {
                        'application/json': {
                            schema: {
                                $ref: string;
                            };
                            examples: {
                                info: {
                                    summary: string;
                                    value: {
                                        operation: string;
                                        releaseSha256: string;
                                    };
                                };
                                run: {
                                    summary: string;
                                    value: {
                                        operation: string;
                                        releaseSha256: string;
                                        id: string;
                                        input: string;
                                    };
                                };
                                runStatus: {
                                    summary: string;
                                    value: {
                                        operation: string;
                                        releaseSha256: string;
                                        id: string;
                                    };
                                };
                                approvals: {
                                    summary: string;
                                    value: {
                                        operation: string;
                                        releaseSha256: string;
                                        page: {
                                            limit: number;
                                        };
                                    };
                                };
                            };
                        };
                    };
                };
                responses: {
                    '200': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    type: string;
                                };
                            };
                        };
                    };
                    '400': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    type: string;
                                    required: string[];
                                    properties: {
                                        status: {
                                            const: string;
                                        };
                                        code: {
                                            type: string;
                                        };
                                    };
                                };
                            };
                        };
                    };
                    '401': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    type: string;
                                    required: string[];
                                    properties: {
                                        status: {
                                            const: string;
                                        };
                                        code: {
                                            type: string;
                                        };
                                    };
                                };
                            };
                        };
                    };
                    '409': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    type: string;
                                    required: string[];
                                    properties: {
                                        status: {
                                            const: string;
                                        };
                                        code: {
                                            type: string;
                                        };
                                    };
                                };
                            };
                        };
                    };
                    '413': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    type: string;
                                    required: string[];
                                    properties: {
                                        status: {
                                            const: string;
                                        };
                                        code: {
                                            type: string;
                                        };
                                    };
                                };
                            };
                        };
                    };
                    '429': {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    type: string;
                                    required: string[];
                                    properties: {
                                        status: {
                                            const: string;
                                        };
                                        code: {
                                            type: string;
                                        };
                                    };
                                };
                            };
                        };
                    };
                };
            };
        };
    };
    components: {
        securitySchemes: {
            reviewerBearer?: {
                type: string;
                scheme: string;
                bearerFormat: string;
                description: string;
            };
            ownerBearer: {
                type: string;
                scheme: string;
                bearerFormat: string;
                description: string;
            };
        };
        schemas: {
            ReleaseOperation: Schema;
        };
    };
};
export {};
