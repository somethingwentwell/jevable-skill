import { describe, expect, it, vi } from 'vitest'
import { readFile, mkdtemp, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { PreviewSession } from '../src/preview/session.ts'
import { renderPreview } from '../src/preview/index.ts'
import { previewProjectPinSchema } from '../src/preview/project-pin.ts'
import { previewSelection, portablePreviewSelection } from '../src/cli/preview.ts'
import { readPreviewProjectPin } from '../src/cli/preview-project.ts'
import { startPreviewGateway } from '../src/http/preview-gateway.ts'
import { showSchema } from '../src/contracts.ts'

const source = await readFile(new URL('../examples/echo.yaml', import.meta.url), 'utf8')
const pin = { id: randomUUID(), generation: 3, revision: previewProjectPinSchema.shape.revision.parse(renderPreview(source).data.revision) }
const hash = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex')
const view = { id: pin.id, generation: pin.generation, acceptedRevision: pin.revision, archived: false }

describe('explicit reviewed existing preview project; no create or execution fallback', () => {
  it('attaches with exactly one owner read and captures an owned immutable pin', async () => {
    const selected = { ...pin }, call = vi.fn().mockResolvedValue(view)
    const pending = PreviewSession.attach({ call }, source, selected)
    selected.id = randomUUID(); selected.generation = 99; selected.revision = 'f'.repeat(64)
    const session = await pending
    expect(session.pin).toEqual(pin)
    expect(call.mock.calls).toEqual([[{ operation: 'projects.show', id: pin.id }]])
    const exposed = session.pin; exposed.generation = 101
    expect(session.pin).toEqual(pin)
  })
  it.each([
    null, {}, { ...pin, id: 'invalid' }, { ...pin, generation: 0 }, { ...pin, generation: 1.5 },
    { ...pin, generation: Number.MAX_SAFE_INTEGER + 1 }, { ...pin, revision: 'F'.repeat(64) },
    { ...pin, actor: 'spoofed' }, { ...pin, archived: false },
  ])('rejects invalid/extra pin input before touching the owner: %j', async value => {
    const call = vi.fn()
    await expect(PreviewSession.attach({ call }, source, value)).rejects.toHaveProperty('code', 'invalid-command')
    expect(call).not.toHaveBeenCalled()
  })
  it('refuses a different source revision before owner access', async () => {
    const call = vi.fn()
    await expect(PreviewSession.attach({ call }, source, { ...pin, revision: 'a'.repeat(64) })).rejects.toHaveProperty('code', 'conflict')
    expect(call).not.toHaveBeenCalled()
  })
  it.each([
    [{ ...view, generation: 4 }, 'conflict'], [{ ...view, acceptedRevision: 'a'.repeat(64) }, 'conflict'],
    [{ ...view, archived: true }, 'conflict'], [{ ...view, id: randomUUID() }, 'corrupt'],
    [{ ...view, archived: undefined }, 'corrupt'], [{ ...view, generation: '3' }, 'corrupt'],
  ])('refuses stale/archived/foreign/malformed owner replies without writes', async (reply, code) => {
    const call = vi.fn().mockResolvedValue(reply)
    await expect(PreviewSession.attach({ call }, source, pin)).rejects.toHaveProperty('code', code)
    expect(call.mock.calls).toEqual([[{ operation: 'projects.show', id: pin.id }]])
  })
  it('propagates missing/uncertain owner reads without a second call or a create', async () => {
    for (const code of ['not-found', 'transport-uncertain']) {
      const failure = Object.assign(new Error('fixture'), { code }), call = vi.fn().mockRejectedValue(failure)
      await expect(PreviewSession.attach({ call }, source, pin)).rejects.toBe(failure)
      expect(call).toHaveBeenCalledTimes(1)
    }
  })
  it('rejects a mismatched gateway project identity before binding or owner access', async () => {
    const call = vi.fn()
    await expect(startPreviewGateway({ source, projectId: randomUUID(), projectPin: pin, token: '1'.repeat(64) }, { call }))
      .rejects.toHaveProperty('code', 'invalid-command')
    expect(call).not.toHaveBeenCalled()
  })
  it('publishes the exact strict input contract, not inferred project authority', () => {
    expect(previewProjectPinSchema.parse(pin)).toEqual(pin)
    const schema = showSchema('preview-project-pin')
    expect(schema.schema.additionalProperties).toBe(false)
  })
})

describe('existing-project preview CLI admission and reviewed bounded file', () => {
  const selected = { endpoint: 'https://never-contacted.invalid', 'token-file': 'owner-private',
    'preview-token-file': 'preview-private', 'project-pin-file': 'pin.json', 'project-pin-sha256': 'a'.repeat(64) }
  it('admits all explicit supported targets without target contact', () => {
    expect(previewSelection(selected)).toEqual({ selection: 'remote', port: 0 })
    expect(previewSelection({ 'token-file': 'private', 'project-pin-file': 'pin.json', 'project-pin-sha256': 'a'.repeat(64) })).toEqual({ selection: 'sqlite', port: 0 })
    expect(previewSelection({ 'token-file': 'private', storage: 'postgres', 'database-file': 'database.json',
      'project-pin-file': 'pin.json', 'project-pin-sha256': 'a'.repeat(64) })).toEqual({ selection: 'postgres', port: 0 })
  })
  it.each([
    { 'project-id': randomUUID() }, { 'project-pin-file': undefined }, { 'project-pin-sha256': undefined },
    { 'project-pin-file': '' }, { 'project-pin-sha256': 'A'.repeat(64) }, { 'project-pin-sha256': 'bad' },
    { 'preview-token-file': undefined }, { 'auto-connect': true },
  ])('rejects incomplete/mixed target flags without I/O: %j', extra => {
    expect(() => previewSelection({ ...selected, ...extra })).toThrow()
  })
  it.each(['project-pin-file', 'project-pin-sha256'])('keeps --%s out of portable offline preview', key => {
    expect(() => portablePreviewSelection({ [key]: 'unused' })).toThrow()
  })
  it('verifies exact bytes and strict JSON, including checksum/source/unknown-field refusals', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-preview-pin-')), file = join(directory, 'pin.json')
    const bytes = JSON.stringify(pin)
    await writeFile(file, bytes, { mode: 0o600 })
    const values = { 'project-pin-file': file, 'project-pin-sha256': hash(bytes) }
    expect(await readPreviewProjectPin(source, values)).toEqual(pin)
    await expect(readPreviewProjectPin(source, { ...values, 'project-pin-sha256': '0'.repeat(64) })).rejects.toThrow('reviewed SHA-256')
    for (const invalid of ['not json', JSON.stringify({ ...pin, actor: 'spoofed' }), JSON.stringify({ ...pin, revision: 'b'.repeat(64) })]) {
      await writeFile(file, invalid, { mode: 0o600 })
      await expect(readPreviewProjectPin(source, { ...values, 'project-pin-sha256': hash(invalid) })).rejects.toThrow()
    }
    const oversized = ' '.repeat(4097)
    await writeFile(file, oversized, { mode: 0o600 })
    await expect(readPreviewProjectPin(source, { ...values, 'project-pin-sha256': hash(oversized) })).rejects.toThrow('byte limit')
  })
  it('refuses a final symlink and treats omitted attachment as creation mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jevable-preview-pin-link-')), file = join(directory, 'pin.json'), link = join(directory, 'link.json')
    const bytes = JSON.stringify(pin); await writeFile(file, bytes, { mode: 0o600 }); await symlink(file, link)
    await expect(readPreviewProjectPin(source, { 'project-pin-file': link, 'project-pin-sha256': hash(bytes) })).rejects.toThrow()
    expect(await readPreviewProjectPin(source, {})).toBeUndefined()
  })
})
