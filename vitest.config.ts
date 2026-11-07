import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Socket/child-process integration suites exhaust this host under higher
    // file parallelism. Two workers bound pressure without relaxing deadlines;
    // loaded-host repeatability still needs independent CI qualification.
    maxWorkers: 2,
    // Retained qualification snapshots may contain historical compiled tests.
    // They have their own explicit runners; never mix them into current source discovery.
    exclude: [...configDefaults.exclude, '**/.qualification/**', '**/*.node.test.mjs', '**/*.node-tests.mjs'],
  },
})
