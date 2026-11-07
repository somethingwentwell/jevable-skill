import { expect, it } from 'vitest'
import { mkdtemp, writeFile, readFile, symlink, readdir, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readBoundedBytes, readBoundedRegularBytes } from '../src/files.ts'

it('reads exact bounded regular bytes without writing or changing the file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-inspection-reader-')), path = join(directory, 'file')
  const value = Buffer.from([0, 255, 123, 10]); await writeFile(path, value)
  expect(await readBoundedRegularBytes(path, value.length)).toEqual(value)
  await expect(readBoundedRegularBytes(path, value.length - 1)).rejects.toThrow('exceeds')
  expect(await readFile(path)).toEqual(value); expect(await readdir(directory)).toEqual(['file'])
})
it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('validates byte budget before opening the nonexistent input (%s)', async max => {
  await expect(readBoundedRegularBytes('/does-not-exist', max)).rejects.toThrow('Invalid input byte limit')
})
it('refuses a directory and handles an empty regular file without reading another target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-inspection-reader-')), empty = join(directory, 'empty')
  await writeFile(empty, '')
  await expect(readBoundedRegularBytes(directory, 100)).rejects.toThrow('regular input file')
  expect(await readBoundedRegularBytes(empty, 100)).toEqual(Buffer.alloc(0))
  const child = join(directory, 'child'); await mkdir(child)
  expect((await readdir(directory)).sort()).toEqual(['child', 'empty'])
})
it.skipIf(process.platform === 'win32')('leaves ordinary explicit symlink reads unchanged while inspection refuses the final link', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jevable-inspection-reader-')), path = join(directory, 'file'), alias = join(directory, 'alias')
  const value = Buffer.from('unchanged ordinary input'); await writeFile(path, value); await symlink(path, alias)
  expect(await readBoundedBytes(alias, 100)).toEqual(value)
  await expect(readBoundedRegularBytes(alias, 100)).rejects.toThrow()
  expect(await readFile(path)).toEqual(value)
})
