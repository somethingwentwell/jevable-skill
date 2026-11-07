/**
 * Ready-made workflows offered as templates. Each one rebuilds the idea of a popular n8n or Coze template with Jevable steps
 * only (no third-party connectors): the user pastes text in, and AI, rule, loop and approval steps do the rest. Step titles,
 * descriptions and prompts are workflow content, written in English or Simplified Chinese to match the interface language.
 */
import type { JsonValue } from '../workflow/index.ts';
import type { TutorialModel, TutorialWorkflow } from './types.ts';
/** Language of a template's step titles, descriptions and prompts. */
export type TemplateLanguage = 'en' | 'zh';
/** One template: its card copy, where the idea comes from, a sample input and the workflow it creates. */
export interface WorkflowTemplate {
    readonly id: string;
    readonly titleKey: string;
    readonly summaryKey: string;
    /** The template library whose popular template inspired this one. */
    readonly basedOn: 'n8n' | 'coze' | 'both';
    /** Whether the workflow has AI steps, which need a model. */
    readonly ai: boolean;
    /** Input the guide runs the workflow with; it takes the main path through the graph. */
    readonly sample: Readonly<Record<TemplateLanguage, JsonValue>>;
    readonly build: (language: TemplateLanguage, title: string, model: TutorialModel) => TutorialWorkflow;
}
/** Templates in the order the gallery shows them: the most popular ideas first, the no-AI ones last. */
export declare const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[];
