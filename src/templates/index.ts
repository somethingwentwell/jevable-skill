/** Shared templates for the CLI and future desktop clients. */
import { WORKFLOW_TEMPLATES, type TemplateLanguage } from './builders.ts'
import { templateCopy } from './copy.ts'
import type { TutorialModel } from './types.ts'
export type { TemplateLanguage } from './builders.ts'

/** List templates without coupling consumers to UI localization keys. */
export function listTemplates(language: TemplateLanguage = 'en') {
  return WORKFLOW_TEMPLATES.map(template => ({ id: template.id,
    title: templateCopy[language][template.titleKey] ?? template.id,
    description: templateCopy[language][template.summaryKey] ?? '',
    basedOn: template.basedOn, requiresModel: template.ai, sample: template.sample[language] }))
}

/** Build a draft with an explicit model for AI templates; never invent a working model route. */
export function renderTemplate(id: string, options: { language?: TemplateLanguage; name?: string; model?: TutorialModel } = {}) {
  const template = WORKFLOW_TEMPLATES.find(entry => entry.id === id)
  if (!template) throw new Error('Unknown template. Use templates list to inspect supported IDs.')
  if (template.ai && (!options.model?.provider || !options.model.model)) throw new Error('This template requires an explicit provider and model.')
  const language = options.language ?? 'en'
  const draft = template.build(language, options.name ?? templateCopy[language][template.titleKey] ?? id,
    options.model ?? { provider: 'not-used', model: 'not-used' })
  // Source admission rejects aliases; builders reuse constant configuration objects.
  return JSON.parse(JSON.stringify(draft)) as typeof draft
}
