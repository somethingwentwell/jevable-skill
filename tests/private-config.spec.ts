import { describe, expect, it } from 'vitest'
import { chmod, mkdtemp, symlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeArtifact } from '../src/files.ts'
import { readPrivateConfig } from '../src/http/private-config.ts'
import { readSecretFile } from '../src/providers/secret-input.ts'

describe('private database configuration input', () => {
  it('reads an owned bounded JSON object without accepting a symlink or group-readable file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jevable-private-config-')), file = join(dir, 'database.json'), alias = join(dir, 'alias')
    await writeArtifact(file, JSON.stringify({ password: 'PRIVATE_PASSWORD', nested: { value: 1 } }))
    expect(await readPrivateConfig(file)).toEqual({ password: 'PRIVATE_PASSWORD', nested: { value: 1 } })
    await symlink(file, alias); await expect(readPrivateConfig(alias)).rejects.toMatchObject({ code: 'invalid-command' })
    if (process.platform !== 'win32') {
      await chmod(file, 0o640); await expect(readPrivateConfig(file)).rejects.toMatchObject({ code: 'invalid-command' })
    }
  })
  it.each(['', 'null', '[]', '"PRIVATE_PASSWORD"', '{"password":"PRIVATE_PASSWORD",', ' '.repeat(1_000_001)])('refuses malformed, non-object or oversized content without disclosure', async content => {
    const dir = await mkdtemp(join(tmpdir(), 'jevable-private-config-')), file = join(dir, 'database.json')
    await writeArtifact(file, content)
    await expect(readPrivateConfig(file)).rejects.toMatchObject({ code: 'invalid-command', message: 'Jevable runtime operation failed: invalid-command.' })
  })
  it('rejects invalid UTF-8, directories, missing files and nonblocking FIFO input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jevable-private-config-')), file = join(dir, 'database.json')
    await writeArtifact(file, new Uint8Array([0xff, 0xff]))
    for (const path of [file, dir, join(dir, 'missing')]) await expect(readPrivateConfig(path)).rejects.toMatchObject({ code: 'invalid-command' })
    if (process.platform !== 'win32') {
      const fifo = join(dir, 'fifo'); await promisify(execFile)('mkfifo', ['-m', '600', fifo])
      await expect(readPrivateConfig(fifo)).rejects.toMatchObject({ code: 'invalid-command' })
      await expect(readSecretFile(fifo)).rejects.toMatchObject({ code: 'invalid-config' })
    }
  })
})
