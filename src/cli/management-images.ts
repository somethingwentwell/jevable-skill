import { lstat, stat, access, constants } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { readBoundedBytes, writeArtifact } from '../files.ts'
import { buildManagementImage, inspectManagementImageReceipt, saveManagementImage } from '../images/management.ts'
import { ImageError } from '../images/docker.ts'
import { WorkflowRuntimeError } from '../runtime/errors.ts'
import { CliStorageUsageError, type CliValues } from './runtime.ts'

/** Program packaging is independent of any runtime owner, storage backend, credential or service. */
export async function managementImageFromCli(action: 'build-image' | 'save-image' | 'export-kubernetes', values: CliValues, receiptPath?: string) {
  const required = (name: string) => {
    const value = values[name]
    if (typeof value !== 'string' || !value) throw new CliStorageUsageError(`Provide --${name}.`)
    return value
  }
  const output = required('output')
  if (action === 'export-kubernetes') {
    for (const flag of ['image-receipt', 'receipt-sha256', 'options-file', 'options-sha256']) required(flag)
    const receiptBytes = await readBoundedBytes(required('image-receipt'), 64000)
    const optionsBytes = await readBoundedBytes(required('options-file'), 64000)
    if (createHash('sha256').update(receiptBytes).digest('hex') !== required('receipt-sha256')
      || createHash('sha256').update(optionsBytes).digest('hex') !== required('options-sha256')) throw new WorkflowRuntimeError('conflict')
    const { createManagementKubernetesBundle, managementKubernetesOptionsSchema } = await import('../deployment/management-kubernetes.ts')
    const receipt = inspectManagementImageReceipt(JSON.parse(receiptBytes.toString('utf8')))
    const options = managementKubernetesOptionsSchema.parse(JSON.parse(optionsBytes.toString('utf8')))
    const bundle = await createManagementKubernetesBundle(receipt, options)
    return { status: 'written', ...bundle.manifest, artifact: await writeArtifact(output, bundle.bytes, values.overwrite === true) }
  }
  if (action === 'save-image') {
    const reviewed = required('receipt-sha256')
    if (!receiptPath) throw new CliStorageUsageError('Provide the reviewed management image receipt path.')
    const bytes = await readBoundedBytes(receiptPath, 64000)
    if (createHash('sha256').update(bytes).digest('hex') !== reviewed) throw new WorkflowRuntimeError('conflict')
    const receipt = inspectManagementImageReceipt(JSON.parse(bytes.toString('utf8')))
    return saveManagementImage(receipt, output, values.overwrite === true)
  }
  for (const flag of ['runtime-sha256', 'base-image', 'platform', 'tag', 'docker-context']) required(flag)
  const path = resolve(output)
  try { await lstat(path); throw new ImageError('image-conflict') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (!(await stat(dirname(path))).isDirectory()) throw new ImageError('invalid-image-options')
  await access(dirname(path), constants.W_OK)
  const image = await buildManagementImage(required('runtime-sha256'), { context: required('docker-context'),
    platform: required('platform') as 'linux/arm64' | 'linux/amd64', baseImage: required('base-image'), tag: required('tag') })
  let receipt
  try { receipt = await writeArtifact(path, JSON.stringify(image, null, 2) + '\n') }
  catch { throw new ImageError('image-receipt-write-failed') }
  return { status: 'built', image, receipt }
}
