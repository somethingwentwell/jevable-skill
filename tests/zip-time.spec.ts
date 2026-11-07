import { it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'

it('encodes identical ZIP bytes in positive, negative and UTC timezones', () => {
  const outputs = ['UTC', 'Asia/Singapore', 'America/Los_Angeles', 'Pacific/Kiritimati'].map(TZ => {
    const source = `import {zipSync} from 'fflate'; import {zipEpoch} from ${JSON.stringify(new URL('../src/packages/zip-time.ts', import.meta.url).href)};
      const zip=zipSync({'payload.txt':new TextEncoder().encode('same immutable payload')},{level:6,mtime:zipEpoch()});
      process.stdout.write(Buffer.from(zip).toString('hex'));`
    return execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, TZ, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10000 })
  })
  expect(new Set(outputs).size).toBe(1)
  expect(Buffer.from(outputs[0]!, 'hex').subarray(10, 14).toString('hex')).toBe('00002100')
})
