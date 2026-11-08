import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { configDefaults, defineConfig } from 'vitest/config'

// Test-support scripts that are maintained outside the public repository. A test file that
// imports one of them cannot load in a public clone, so it is skipped and reported instead of
// failing at import. Set JEVABLE_REQUIRE_PRIVATE_TEST_HELPERS=1 to turn the skip off.
const privateTestHelpers = ['tls-fixture', 'check-postgres-telemetry', 'check-telemetry-package',
  'check-documentation-package', 'release-guide-contract']
const root = new URL('./', import.meta.url)
const missingHelpers = privateTestHelpers.filter(name => !existsSync(new URL(`scripts/${name}.mjs`, root)))
const testFiles = (readdirSync(new URL('tests/', root), { recursive: true }) as string[])
  .filter(file => /\.(spec|test)\.ts$/.test(file)).map(file => `tests/${file}`)
const skippedForMissingHelpers = process.env.JEVABLE_REQUIRE_PRIVATE_TEST_HELPERS === '1' ? [] : testFiles
  .filter(file => missingHelpers.some(name => readFileSync(new URL(file, root), 'utf8').includes(`scripts/${name}.mjs`)))
if (skippedForMissingHelpers.length) console.warn(`[jevable] Skipping ${skippedForMissingHelpers.length} test files that need `
  + `test-support scripts missing from this checkout: ${missingHelpers.map(name => `scripts/${name}.mjs`).join(', ')}.`)

export default defineConfig({
  test: {
    // Socket/child-process integration suites exhaust this host under higher
    // file parallelism. Two workers bound pressure without relaxing deadlines;
    // loaded-host repeatability still needs independent CI qualification.
    maxWorkers: 2,
    // Retained qualification snapshots may contain historical compiled tests.
    // They have their own explicit runners; never mix them into current source discovery.
    exclude: [...configDefaults.exclude, '**/.qualification/**', '**/*.node.test.mjs', '**/*.node-tests.mjs',
      ...skippedForMissingHelpers],
  },
})
