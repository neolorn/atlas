import { mergeConfig } from 'vitest/config';

import shared from './vitest.config';

/**
 * The toolkit suite, which is the shared configuration plus a cache directory of its own.
 *
 * Vitest resolves its results cache to `<cacheDir>/vitest/<sha1 of the project name>`, and a suite
 * with no project name hashes the empty string, so two of them share one `results.json`. Each run
 * then replaces the other's record of which tests failed, which is the input to the ordering vitest
 * applies on the next run. The gate runs the two suites at the same time, so without a cache
 * directory here two processes write one file, and a wrong cache costs ordering rather than
 * results, which is to say it costs nothing anyone would see.
 *
 * The shared configuration is imported rather than copied, so the reasoning behind the one alias it
 * carries stays in one place. The two injecting verifiers use that file directly and keep the
 * unnamed cache; they run alone, so nothing else is writing it while they do.
 */
export default mergeConfig(shared, {
  cacheDir: 'node_modules/.vite/toolkit',
});
