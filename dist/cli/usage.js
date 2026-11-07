export class CliStorageUsageError extends Error {
    constructor(message = 'Select sqlite with --data-dir or postgres with --database-file; never mix storage settings.') { super(message); }
}
