/** Shared templates for the CLI and future desktop clients. */
import { type TemplateLanguage } from './builders.ts';
import type { TutorialModel } from './types.ts';
export type { TemplateLanguage } from './builders.ts';
/** List templates without coupling consumers to UI localization keys. */
export declare function listTemplates(language?: TemplateLanguage): {
    id: string;
    title: string;
    description: string;
    basedOn: "n8n" | "coze" | "both";
    requiresModel: boolean;
    sample: import("../index.ts").JsonValue;
}[];
/** Build a draft with an explicit model for AI templates; never invent a working model route. */
export declare function renderTemplate(id: string, options?: {
    language?: TemplateLanguage;
    name?: string;
    model?: TutorialModel;
}): import("./types.ts").TutorialWorkflow;
