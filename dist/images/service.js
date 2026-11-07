import { z } from 'zod';
import { createHash } from 'node:crypto';
import { createReleaseFiles } from "../packages/release-zip.js";
import { dockerCommand, ImageError } from "./docker.js";
import { buildSchema, buildLocalImage, saveLocalImage, hashSchema as hash, imageIdentityFields, parsed } from "./local.js";
export const imageReceiptSchema = z.strictObject({
    schemaVersion: z.literal(1), format: z.literal('jevable.ai/image-receipt'), ...imageIdentityFields,
    releaseId: z.uuid(), releaseSha256: hash, revision: hash,
    runtime: z.strictObject({ version: z.string().min(1).max(128), sha256: hash }),
    manifestSha256: hash,
});
const digest = (value) => createHash('sha256').update(value).digest('hex');
function labels(receipt) {
    return { 'ai.jevable.release.id': receipt.releaseId, 'ai.jevable.release.sha256': receipt.releaseSha256,
        'ai.jevable.workflow.revision': receipt.revision, 'ai.jevable.runtime.version': receipt.runtime.version,
        'ai.jevable.runtime.sha256': receipt.runtime.sha256, 'ai.jevable.base.image': receipt.baseImage,
        'ai.jevable.platform': receipt.platform, 'ai.jevable.manifest.sha256': receipt.manifestSha256 };
}
function verifyImage(image, receipt) {
    if (image.Id !== receipt.imageId || `${image.Os}/${image.Architecture}` !== receipt.platform
        || image.Config?.User !== 'node' || JSON.stringify(image.Config?.Entrypoint) !== JSON.stringify(['node', 'app.mjs'])
        || image.Config?.WorkingDir !== '/app' || image.Config?.OnBuild?.length
        || Object.entries(labels(receipt)).some(([key, value]) => image.Config?.Labels?.[key] !== value))
        throw new ImageError('image-mismatch');
}
/** Build only owned files into an explicit local Docker engine. Never pushes, runs workflows or replaces tags. */
export async function buildReleaseImage(release, artifact, input, run = dockerCommand) {
    const options = parsed(buildSchema, input), files = createReleaseFiles(release, artifact);
    const metadata = { releaseId: release.snapshot.id, releaseSha256: release.sha256, revision: release.snapshot.workflow.revision,
        runtime: release.snapshot.runtime, manifestSha256: digest(files['manifest.json']), ...options };
    const identity = await buildLocalImage(options, files, labels(metadata), (image, imageId) => verifyImage(image, { ...metadata, imageId }), run);
    return parsed(imageReceiptSchema, { schemaVersion: 1, format: 'jevable.ai/image-receipt', ...metadata, ...identity });
}
/** Stream an immutable image ID, not a mutable tag, into an atomically published Docker-loadable archive. */
export async function saveReleaseImage(value, path, overwrite = false, run = dockerCommand) {
    const receipt = parsed(imageReceiptSchema, value);
    return { ...await saveLocalImage(receipt, path, overwrite, image => verifyImage(image, receipt), run),
        format: 'jevable.ai/image-archive', image: receipt };
}
export function inspectImageReceipt(value) { return parsed(imageReceiptSchema, value); }
