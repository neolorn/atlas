import { mergeConfig } from 'vitest/config';

import shared from './vitest.config';

/**
 * The two suites a mutant is allowed to be measured against.
 *
 * Stryker runs one vitest configuration, and the root one discovers every `*.test.ts` under the
 * repository that the shared excludes do not remove. That is the right default for a developer and
 * the wrong one here: the consumer and browser suites cost minutes per run against a single mutant,
 * and there are tens of thousands of mutants. Naming the two fast directories is what keeps a
 * weekly job weekly.
 *
 * It is also what the score means. A mutant that survives here survived *these* suites, and the
 * report is read as a list of places the fast suites do not look, not as a claim about Atlas's
 * coverage overall, which the consumer, browser and injection gates carry and this cannot see.
 */
export default mergeConfig(shared, {
  cacheDir: 'node_modules/.vite/mutation',
  test: {
    include: [
      'packages/runtime/test/**/*.test.ts',
      'packages/toolkit/test/**/*.test.ts',
    ],
  },
});
