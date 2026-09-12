import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The rule that keeps this layer from becoming a second, private API.
 *
 * Runtime unit tests import modules directly, `../src/parsing.js` rather than
 * `../src/public-api.js`, because the barrel reaches `@angular/common`, whose `PlatformLocation`
 * needs the JIT compiler, and requiring an Angular test harness here would give back the startup
 * cost that is the whole point of the layer.
 *
 * A direct module import can reach anything the module exports, including things no consumer can
 * call. Tests written against those would pin Atlas's internal shape: the sign-mark fix rewrote
 * `numberSyntax`, and a test of `numberSyntax` would have had to be rewritten with it, for no gain
 * in confidence. So the rule is not "import the barrel", it cannot be, but **exercise only what
 * the barrel re-exports**, and this asserts it rather than trusting it.
 *
 * Add a symbol here when a unit test starts using it. If it is not a public export, the test should
 * not exist: either the behaviour is reachable from the public surface and should be asserted
 * through it, or it is not, and the feature lab is where it belongs.
 */

const sourceRoot = new URL('../src/', import.meta.url);
const read = (file: string): string =>
  readFileSync(fileURLToPath(new URL(file, sourceRoot)), 'utf8');

const publicApi = read('public-api.ts');

/**
 * Names the barrel publishes, following `export * from './x'` into the module it names.
 *
 * The star re-exports are the reason this cannot be a single regular expression over one file:
 * `formatLocalizedInput` never appears in `public-api.ts` at all. It reaches consumers through
 * `export * from './localized-input'`.
 */
function publishedNames(): ReadonlySet<string> {
  const names = new Set<string>();

  const collect = (source: string): void => {
    for (const [, group] of source.matchAll(/export\s*\{([^}]*)\}/gu)) {
      if (group === undefined) continue;
      for (const entry of group.split(',')) {
        const name = entry
          .trim()
          .replace(/^type\s+/u, '')
          .split(/\s+as\s+/u)
          .at(-1)
          ?.trim();
        if (name) names.add(name);
      }
    }
    for (const [, name] of source.matchAll(
      /export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+(\w+)/gu,
    )) {
      if (name !== undefined) names.add(name);
    }
  };

  collect(publicApi);
  for (const [, module] of publicApi.matchAll(
    /export\s+\*\s+from\s+'\.\/([\w.-]+)'/gu,
  )) {
    collect(read(`${module}.ts`));
  }
  return names;
}

/** Every symbol the runtime unit layer currently calls. */
const exercised: readonly string[] = Object.freeze([
  'decimal',
  'formatLocalizedInput',
  'formatMeasurement',
  'formatMoney',
  'formatNumber',
  'measurement',
  'money',
  'negotiateLocale',
  'parseAcceptLanguage',
  'parseLocalizedInput',
  'RUNTIME_LIMITS',
]);

describe('the runtime unit layer only exercises published surface', () => {
  const published = publishedNames();

  it.each(exercised)('%s is published', (symbol) => {
    expect(
      published.has(symbol),
      `${symbol} is not reachable from public-api.ts`,
    ).toBe(true);
  });

  it('does not consider an internal helper published, so the check is not vacuous', () => {
    // `numberSyntax` lives in `parsing.ts`, which the barrel star-re-exports, but it carries no
    // `export` keyword. If this ever passes, the resolver has stopped distinguishing the two and
    // every assertion above has become decoration.
    expect(published.has('numberSyntax')).toBe(false);
    expect(published.has('stripSign')).toBe(false);
  });

  it('resolves star re-exports at all, so a barrel change cannot silently empty it', () => {
    expect(published.size).toBeGreaterThan(100);
    expect(published.has('formatLocalizedInput')).toBe(true);
  });
});
