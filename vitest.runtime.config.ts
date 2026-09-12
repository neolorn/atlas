import { mergeConfig } from 'vitest/config';

import shared from './vitest.config';

/** The runtime suite. `vitest.toolkit.config.ts` carries the reasoning for the separate cache. */
export default mergeConfig(shared, {
  cacheDir: 'node_modules/.vite/runtime',
});
