/** Only bounded categories cross the exporter boundary; never collector text or credentials. */
export class ExportFailure extends Error {
  constructor(readonly category: 'transport' | 'response' | 'serialization') { super(category) }
}
