import { createHash } from 'node:crypto';
import { readBoundedRegularBytes } from "../files.js";
import { admitPreviewProjectPin } from "../preview/project-pin.js";
import { CliStorageUsageError } from "./runtime.js";
/** Exact file checksum and workflow revision, before credentials, target contact or storage. */
export async function readPreviewProjectPin(source, values) {
    if (values['project-pin-file'] === undefined)
        return undefined;
    const bytes = await readBoundedRegularBytes(values['project-pin-file'], 4096);
    if (createHash('sha256').update(bytes).digest('hex') !== values['project-pin-sha256']) {
        throw new CliStorageUsageError('The preview project pin file differs from its reviewed SHA-256.');
    }
    let value;
    try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    catch {
        throw new CliStorageUsageError('Invalid preview project pin JSON.');
    }
    return admitPreviewProjectPin(source, value);
}
