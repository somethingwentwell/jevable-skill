import { z } from 'zod';
/** Shared workflow/reviewer grammar. Authority still comes from the exact live node and grant. */
export const approvalActionSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u)
    .refine(value => !['__proto__', 'constructor', 'prototype', 'default', 'next', 'timeout'].includes(value));
