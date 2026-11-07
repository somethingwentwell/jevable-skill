import { z } from 'zod';
import { createHash } from 'node:crypto';
import { createManagementFiles } from "../management/package.js";
import { readBoundedBytes } from "../files.js";
import { buildSchema, buildLocalImage, saveLocalImage, hashSchema, imageIdentityFields, parsed } from "./local.js";
import { dockerCommand, ImageError } from "./docker.js";
const runtime = (role) => z.strictObject({ role: z.literal(role), sha256: hashSchema, bytes: z.number().int().min(1).max(32_000_000) });
export const managementImageReceiptSchema = z.strictObject({ schemaVersion: z.literal(1), format: z.literal('jevable.ai/management-image-receipt'),
    ...imageIdentityFields, coreVersion: z.string().min(1).max(128),
    runtimes: z.tuple([runtime('management'), runtime('sqlite'), runtime('postgres')]),
    manifestSha256: hashSchema, recipeSha256: hashSchema, state: z.literal('excluded'), credentials: z.literal('excluded') });
const digest = (value) => createHash('sha256').update(value).digest('hex');
const dockerfile = `ARG NODE_IMAGE
FROM \${NODE_IMAGE}
USER root
WORKDIR /app
COPY --chown=node:node bin/ ./bin/
COPY --chown=node:node dist/ ./dist/
COPY --chown=node:node manifest.json README.txt ./
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
HEALTHCHECK NONE
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "bin/jevable.mjs"]
CMD ["capabilities"]
`;
const ignore = '*\n!bin/\n!bin/**\n!dist/\n!dist/**\n!manifest.json\n!README.txt\n!Dockerfile\n!.dockerignore\n';
function labels(value) {
    return { 'ai.jevable.mode': 'management', 'ai.jevable.core.version': value.coreVersion,
        'ai.jevable.management.sha256': value.runtimes[0].sha256, 'ai.jevable.release-sqlite.sha256': value.runtimes[1].sha256,
        'ai.jevable.release-postgres.sha256': value.runtimes[2].sha256, 'ai.jevable.manifest.sha256': value.manifestSha256,
        'ai.jevable.recipe.sha256': value.recipeSha256, 'ai.jevable.base.image': value.baseImage, 'ai.jevable.platform': value.platform };
}
function verify(image, value) {
    if (image.Id !== value.imageId || `${image.Os}/${image.Architecture}` !== value.platform
        || image.Config?.User !== 'node' || image.Config?.WorkingDir !== '/app' || image.Config?.OnBuild?.length
        || JSON.stringify(image.Config?.Entrypoint) !== JSON.stringify(['node', 'bin/jevable.mjs'])
        || JSON.stringify(image.Config?.Cmd) !== JSON.stringify(['capabilities']) || image.Config?.StopSignal !== 'SIGTERM'
        || JSON.stringify(image.Config?.Healthcheck?.Test) !== JSON.stringify(['NONE'])
        || Object.entries(labels(value)).some(([key, expected]) => image.Config?.Labels?.[key] !== expected))
        throw new ImageError('image-mismatch');
}
/** Read-only validation shared with the explicit lifecycle owner; never accept a release-only image. */
export function verifyManagementImage(image, receipt) {
    verify(image, inspectManagementImageReceipt(receipt));
}
/** Packages this reviewed management program only; never opens state, starts containers or discovers a daemon. */
export async function buildManagementImage(expectedRuntimeSha256, input, run = dockerCommand, readBytes = readBoundedBytes) {
    const options = parsed(buildSchema, input), expected = parsed(hashSchema, expectedRuntimeSha256);
    const { files, manifest } = await createManagementFiles(readBytes);
    const runtimes = parsed(managementImageReceiptSchema.shape.runtimes, manifest.runtimes);
    if (runtimes[0].sha256 !== expected)
        throw new ImageError('image-mismatch');
    const metadata = { ...options, coreVersion: manifest.version, runtimes, manifestSha256: digest(files['manifest.json']),
        recipeSha256: digest(dockerfile + '\0' + ignore) };
    const identity = await buildLocalImage(options, { ...files, Dockerfile: Buffer.from(dockerfile), '.dockerignore': Buffer.from(ignore) }, labels(metadata), (image, imageId) => verify(image, { ...metadata, imageId }), run);
    return parsed(managementImageReceiptSchema, { schemaVersion: 1, format: 'jevable.ai/management-image-receipt',
        ...metadata, ...identity, state: 'excluded', credentials: 'excluded' });
}
export function inspectManagementImageReceipt(value) { return parsed(managementImageReceiptSchema, value); }
export async function saveManagementImage(value, path, overwrite = false, run = dockerCommand) {
    const receipt = inspectManagementImageReceipt(value);
    return { ...await saveLocalImage(receipt, path, overwrite, image => verify(image, receipt), run),
        format: 'jevable.ai/management-image-archive', image: receipt };
}
