import {
  parseAtlasConfiguration,
  type AtlasProjectConfiguration,
} from '../src/index.js';

/**
 * A project configuration for a test, built by the parser that reads a real one.
 *
 * Three suites carried the same hand-written object literal, and every one of them was wrong in the
 * same way: `AtlasProjectConfiguration` gained `pseudoLocales` and nothing said so, because nothing
 * typechecked a test file. A literal is also the wrong shape for a different reason: `locales`,
 * `sourceLocale` and `defaultLocale` are `AtlasLocale`, a branded type no literal can produce, so
 * writing one out either casts the brand away or does not compile.
 *
 * Going through `parseAtlasConfiguration` answers both. The fixture is whatever the parser produces
 * from the source a project would actually contain, so a field added to the configuration is
 * supplied here on the day it lands rather than remembered, and the locales are branded by the
 * function that owns the brand. It is the general rule for a value under test: validate it
 * against the Atlas function that will receive it, not against the primitive underneath.
 */
export function testProjectConfiguration(
  locales: readonly string[],
  overrides: Readonly<Record<string, unknown>> = {},
): AtlasProjectConfiguration {
  const [sourceLocale] = locales;
  if (sourceLocale === undefined) {
    throw new Error('A test configuration needs at least one locale.');
  }
  const parsed = parseAtlasConfiguration(
    JSON.stringify({
      schemaVersion: 1,
      sourceLocale,
      defaultLocale: sourceLocale,
      locales,
      ...overrides,
    }),
  );
  if (!parsed.ok) {
    throw new Error(
      `The test configuration is not an Atlas configuration: ${parsed.diagnostics
        .map(({ code, summary }) => `${code} ${summary}`)
        .join('; ')}`,
    );
  }
  return parsed.value;
}
