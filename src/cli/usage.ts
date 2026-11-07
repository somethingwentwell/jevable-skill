/** Storage-free CLI definitions, also used by independently bundled workflow apps. */
export type CliValues = Record<string, string | boolean | undefined>
export class CliStorageUsageError extends Error {
  constructor(message = 'Select sqlite with --data-dir or postgres with --database-file; never mix storage settings.') { super(message) }
}
