import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { verifyScopedLayerDiff } from '../scripts/scoped-support-layer-diff.mjs'
const bytes = Buffer.alloc(100000, 42), compressed = gzipSync(bytes)
const diff = 'sha256:' + createHash('sha256').update(bytes).digest('hex')
test('complete streaming support layer verification', async () => {
  assert.deepEqual(await verifyScopedLayerDiff(compressed, diff, bytes.length), { diffId: diff, uncompressedBytes: bytes.length, maximumUncompressedBytes: bytes.length })
})
test('reject mismatched diff ID', async () => { await assert.rejects(verifyScopedLayerDiff(compressed, 'sha256:' + '0'.repeat(64)), /diff ID mismatch/u) })
test('reject explicit inflation boundary overflow', async () => { await assert.rejects(verifyScopedLayerDiff(compressed, diff, 99999), /explicit profile bound/u) })
test('reject corrupt compression', async () => { await assert.rejects(verifyScopedLayerDiff(Buffer.from('invalid'), diff)) })
test('reject unsupported greater-than-512-MiB profile', async () => { await assert.rejects(verifyScopedLayerDiff(compressed, diff, 536870913)) })
