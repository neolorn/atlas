import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * One alias, and only one.
 *
 * `@neolorn/atlas/core` is a real published entry point, so the package's own sources import it by
 * that specifier rather than reaching across directories, which is what keeps the core compiled
 * into exactly one bundle. Under vitest there is no published package to resolve it against, so it
 * is mapped to the source the entry point is built from.
 *
 * The primary is deliberately *not* aliased. An earlier attempt to alias `@neolorn/atlas` to
 * `src/public-api.ts` threw `The injectable 'PlatformLocation' needs to be compiled using the JIT
 * compiler`, which was not a configuration problem to work around but the finding that started
 * this step: the primary cannot be loaded outside an Angular application. `core` and `http` import
 * no Angular at all, which is why aliasing them is safe and aliasing the primary is not.
 */
export default defineConfig({
  test: {
    /**
     * `tmp/` is never a source of tests, and after a red gate it holds four copies of them.
     *
     * `verify.mjs` keeps its worktrees under `tmp/verify-trees` when a run fails, so a resume
     * can reuse them, and vitest's positional filter is a substring match on the file path, so
     * `packages/toolkit/test` then matches the copy inside every kept tree as well as the real one.
     * A local `test:toolkit` went from 38 files to 190 without saying anything had changed.
     *
     * The cost is not the duration. Those copies are pinned at whatever commit the failed run was
     * gating, so a local suite silently runs stale tests beside current ones and reports them
     * together: a case deleted an hour ago comes back to life, and a fixture that moved fails in a
     * tree nobody is editing. Excluded here rather than in each suite, because it is true of all of
     * them and of anything added later.
     */
    exclude: ['**/node_modules/**', '**/dist/**', 'tmp/**'],
    /**
     * A hang detector, not a performance budget.
     *
     * Vitest's default is 5000ms and nobody here chose it. Under full-suite load the slowest
     * toolkit tests run between 3.3s and 6.0s, and this machine's own throughput moves about a
     * quarter across an hour, so a test measured at 4.2s passes or fails depending on when it
     * runs, and four tests had already been given individual escapes as they crossed. Green is not
     * allowed to depend on how busy the machine is.
     *
     * What a test costs is asserted by `verify:edit-cost`, which measures it. This number only has
     * to be high enough that reaching it means the test is never going to finish, and low enough to
     * sit inside the stage bound so a failure names the test rather than the stage: the same
     * inner-bound-inside-outer-guard shape as the `page.evaluate` bound in
     * `tools/verify-package-consumer-hydration.mjs`.
     */
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@neolorn/atlas/core': fileURLToPath(
        new URL('./packages/runtime/core/src/public-api.ts', import.meta.url),
      ),
    },
  },
});
