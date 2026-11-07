import { z } from 'zod';
import type { Project } from '../projects/ledger.ts';
import type { LocalRun } from './run-types.ts';
export declare const ACTIVITY_LIMITS: Readonly<{
    projects: 1000;
    runs: 100000;
    projectChanges: 1000000;
}>;
declare const reviews: z.ZodObject<{
    proposed: z.ZodNumber;
    accepted: z.ZodNumber;
    rejected: z.ZodNumber;
}, z.core.$strict>;
declare const origins: z.ZodObject<{
    authored: z.ZodNumber;
    duplicated: z.ZodNumber;
    projectBundle: z.ZodNumber;
    vendor: z.ZodNumber;
}, z.core.$strict>;
/** Counts are retained installation state, not account/billing/lifetime totals or proof of live execution. */
export declare const activityReportSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    storage: z.ZodEnum<{
        sqlite: "sqlite";
        postgres: "postgres";
    }>;
    observedAt: z.ZodISODateTime;
    scope: z.ZodLiteral<"selected-owner-retained-data">;
    consistency: z.ZodLiteral<"single-owner-coherent-observation">;
    projects: z.ZodObject<{
        total: z.ZodNumber;
        active: z.ZodNumber;
        archived: z.ZodNumber;
        origins: z.ZodObject<{
            authored: z.ZodNumber;
            duplicated: z.ZodNumber;
            projectBundle: z.ZodNumber;
            vendor: z.ZodNumber;
        }, z.core.$strict>;
    }, z.core.$strict>;
    proposals: z.ZodObject<{
        total: z.ZodNumber;
        pending: z.ZodNumber;
        accepted: z.ZodNumber;
        rejected: z.ZodNumber;
        importedHistory: z.ZodNumber;
        localActions: z.ZodObject<{
            proposed: z.ZodNumber;
            accepted: z.ZodNumber;
            rejected: z.ZodNumber;
        }, z.core.$strict>;
    }, z.core.$strict>;
    imports: z.ZodObject<{
        projectBundle: z.ZodNumber;
        vendor: z.ZodNumber;
        basis: z.ZodLiteral<"retained-project-origin">;
    }, z.core.$strict>;
    runs: z.ZodObject<{
        total: z.ZodNumber;
        byStatus: z.ZodObject<{
            paused: z.ZodNumber;
            executing: z.ZodNumber;
            waiting: z.ZodNumber;
            completed: z.ZodNumber;
            failed: z.ZodNumber;
            cancelled: z.ZodNumber;
        }, z.core.$strict>;
        links: z.ZodObject<{
            project: z.ZodNumber;
            release: z.ZodNumber;
            unlinked: z.ZodNumber;
        }, z.core.$strict>;
        triggerSelection: z.ZodObject<{
            api: z.ZodNumber;
            defaultLocal: z.ZodNumber;
        }, z.core.$strict>;
        firstRetainedRun: z.ZodNullable<z.ZodObject<{
            id: z.ZodUUID;
            revision: z.ZodString;
            createdAt: z.ZodISODateTime;
            status: z.ZodEnum<{
                cancelled: "cancelled";
                completed: "completed";
                paused: "paused";
                failed: "failed";
                waiting: "waiting";
                executing: "executing";
            }>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    privacy: z.ZodLiteral<"counts-and-first-run-identifiers; no-payloads-actors-or-credentials">;
    execution: z.ZodLiteral<"not-started-resumed-approved-or-cancelled">;
    billing: z.ZodLiteral<false>;
    lifetimeTotals: z.ZodLiteral<false>;
}, z.core.$strict>;
export type ActivityReport = z.infer<typeof activityReportSchema>;
export type ActivityProject = {
    id: string;
    generation: number;
    archived: boolean;
    origin: keyof z.infer<typeof origins>;
    proposals: {
        pending: number;
        accepted: number;
        rejected: number;
        importedHistory: number;
    };
    localActions: z.infer<typeof reviews>;
};
export type ActivityRun = Pick<LocalRun, 'id' | 'revision' | 'createdAt' | 'triggerMode' | 'project' | 'release'> & {
    status: LocalRun['state']['status'];
};
/** Called only with an already decoded/replayed owned ledger. Foreign history is not local authoring activity. */
export declare function activityProject(project: Project, vendor: boolean): ActivityProject;
export declare function activityRun(run: LocalRun): ActivityRun;
/** Bounded metadata only. Never reads storage, calls a provider, dispatches execution or exports telemetry. */
export declare function createActivityReport(storage: ActivityReport['storage'], projects: readonly ActivityProject[], runs: readonly ActivityRun[]): ActivityReport;
export {};
