/** Model route selected explicitly by the caller; credentials never enter templates. */
export interface TutorialModel {
  readonly provider: string
  readonly model: string
}

/** A template draft still requires normal compilation and runtime admission. */
export interface TutorialWorkflow {
  readonly apiVersion: string
  readonly kind: string
  readonly metadata: { readonly id: string; readonly name: string; readonly description: string }
  readonly spec: Readonly<Record<string, unknown>>
}
