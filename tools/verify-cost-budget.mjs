/**
 * Cost budget.
 *
 * Nothing else in the repository measures time or memory. A quadratic stall on a public entry
 * point returns the right answer, and so does a re-admission of a whole catalog on every request,
 * so every other check in this gate passes both. The cost is the only thing about either of them
 * that is wrong, and it is the one thing nothing here would see.
 *
 * Every check here asserts the *shape* of a cost, never a wall-clock number. These run on whatever
 * machine CI provides, which is never the production host, so an absolute millisecond limit
 * measures the runner and not Atlas: flaky where the runner is slow, and once padded enough to stop
 * being flaky, unable to fail. Complexity transfers across machines; milliseconds do not.
 *
 * `specs/12-verification.spec.md` section 10 states that as a rule: assert the shape of a cost
 * rather than an absolute duration wherever the measurement runs on a machine Atlas does not
 * control. Section 11 is the other half of it: no recorded timing figure is kept as a threshold a
 * later run is compared against, so a growth curve is judged by the shape its own measurements
 * take.
 *
 * What this deliberately does not do is size a consumer's server. How much concurrency one host
 * sustains depends on its cores, its memory and what else runs on it. That is consumer capacity
 * planning. Atlas's job is to guarantee the curve is the right shape.
 *
 * `specs/12-verification.spec.md` section 12 keeps that boundary: capacity, budgets and traffic
 * objectives belong to the application, and Atlas supplies the instrument rather than the
 * target.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(resolve(workspaceRoot, 'package.json'));

await import(pathToFileURL(require_.resolve('@angular/compiler')).href);
// The toolkit is read from the materialized consumer rather than from `dist/toolkit` directly.
// A staged package is a set of files, not an installed one: nothing resolves its dependencies in
// place, so importing it from the workspace root fails the moment it reaches its own imports. The
// consumer install is the same artifact a consumer receives, correctly resolved, which makes it
// both the working import and the more faithful one.
const consumerToolkit = resolve(
  workspaceRoot,
  'tmp/package-consumer-verification/package-consumer/node_modules/@neolorn/atlas-toolkit/index.js',
);
if (!existsSync(consumerToolkit)) {
  process.stderr.write(
    'The cost budget measures the installed toolkit. Run "pnpm run verify:consumer" first.\n',
  );
  process.exit(1);
}
const tk = await import(pathToFileURL(consumerToolkit).href);
// The modules rather than the package entry. The compiler's own machinery is not published:
// nothing outside Atlas calls it, so it is not part of the toolkit's surface, and a gate that
// exercises it reaches the module that declares it.
const { compileAtlasLocalArtifacts } = await import(
  pathToFileURL(resolve(dirname(consumerToolkit), 'compiled-artifacts.js')).href
);
const { analyzeAtlasCatalogSet } = await import(
  pathToFileURL(resolve(dirname(consumerToolkit), 'semantic-model.js')).href
);
const rt = await import(
  pathToFileURL(
    resolve(workspaceRoot, 'dist/runtime/fesm2022/neolorn-atlas.mjs'),
  ).href
);

/**
 * Each check declares the state it is currently expected to be in, so a known defect does not sit
 * in the gate as a permanent red that hides the next regression.
 *
 * - `pass` that fails    -> gate failure. A cost changed shape.
 * - `known-fail` that fails -> reported, gate stays green. The defect is recorded, not forgotten.
 * - `known-fail` that passes -> gate failure. The defect was fixed and this file must be updated,
 *   otherwise the check silently stops guarding anything.
 */
const results = [];
const record = (name, expectation, passed, detail) => {
  const surprising =
    (expectation === 'pass' && !passed) ||
    (expectation === 'known-fail' && passed);
  results.push({ name, expectation, passed, surprising, detail });
  const label = surprising
    ? passed
      ? 'FIXED'
      : 'FAIL '
    : passed
      ? 'pass '
      : 'known';
  process.stdout.write(`${label}  ${name}\n      ${detail}\n`);
};

const elapsedMs = (run) => {
  const start = process.hrtime.bigint();
  run();
  return Number(process.hrtime.bigint() - start) / 1e6;
};

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

/* ------------------------------------------------------------------ *
 * E1: decimal() normalisation must not be quadratic in input length. *
 * ------------------------------------------------------------------ */

// `1.<n zeros>1` forces the unanchored /0+$/u to retry from every start position. An all-zeros
// fraction matches immediately and measures nothing, which is the easy mistake here.
const pathological = (zeros) => `1.${'0'.repeat(zeros)}1`;

const decimalTimings = new Map();
for (const zeros of [8000, 16000, 32000]) {
  const samples = [];
  for (let run = 0; run < 3; run += 1) {
    samples.push(elapsedMs(() => rt.decimal(pathological(zeros))));
  }
  decimalTimings.set(zeros, median(samples));
}

const decimalGrowth =
  decimalTimings.get(32000) / Math.max(decimalTimings.get(8000), 0.001);

// Linear work grows 4x across a 4x input. Quadratic grows 16x. The midpoint is a wide gap, so this
// stays decisive without being sensitive to runner speed.
const DECIMAL_LIMIT = 9;
record(
  'decimal() is sub-quadratic in input length',
  // The trailing-zero strip is a single backward scan instead of an unanchored regex that
  // restarted at every position. This guards that.
  'pass',
  decimalGrowth < DECIMAL_LIMIT,
  `4x input grew cost ${decimalGrowth.toFixed(1)}x (linear ~4x, quadratic ~16x, limit ${DECIMAL_LIMIT}x); ` +
    [...decimalTimings]
      .map(([zeros, ms]) => `${zeros}:${ms.toFixed(1)}ms`)
      .join(' '),
);

/* ----------------------------------------------------------------------- *
 * B4: per-request snapshot construction must not scale with catalog size. *
 * ----------------------------------------------------------------------- */

/**
 * Parsed by the toolkit, not written out here.
 *
 * This was an object literal, and it drifted: `personNameLocales` became a required field of
 * the loaded configuration (optional in `atlas.config.json`, defaulted by the loader) and
 * this literal never gained it. `analyzeAtlasCatalogSet` spreads that field unconditionally,
 * correctly, because every configuration it is meant to receive has been through the loader.
 * So the whole gate died on a value only this file could produce, while no consumer could hit
 * it at all.
 *
 * A `.mjs` tool fabricating a value of a TypeScript type is unchecked by construction, so
 * adding the missing key would only reset the clock. Going through the loader means the
 * configuration this measures is built the way a consumer's is, and a field added later
 * arrives here with its default rather than as a crash.
 */
const parsedConfiguration = tk.parseAtlasConfiguration(
  JSON.stringify({
    schemaVersion: 1,
    sourceLocale: 'en-US',
    defaultLocale: 'en-US',
    locales: ['en-US'],
  }),
);
if (!parsedConfiguration.ok) {
  process.stderr.write(
    `The cost budget's own configuration did not load: ${(
      parsedConfiguration.diagnostics ?? []
    )
      .map(({ code, summary }) => `${code} ${summary}`)
      .join('; ')}\n`,
  );
  process.exit(1);
}
const configuration = parsedConfiguration.value;

async function artifactsFor(messageCount) {
  const lines = ['messages:'];
  for (let index = 0; index < messageCount; index += 1) {
    lines.push(`  m.k${index}: "Message number ${index} with a little body."`);
  }
  const parsed = tk.parseAtlasCatalog(`${lines.join('\n')}\n`, {
    role: 'source',
    providerId: 'p',
    scopeId: 's',
    locale: 'en-US',
  });
  if (!parsed.ok) throw new Error('cost budget fixture failed to parse');
  const graph = analyzeAtlasCatalogSet({
    configuration,
    catalogs: [parsed.value],
  });
  const compiled = compileAtlasLocalArtifacts({
    owner: {
      providerId: '@neolorn/atlas-verify',
      generatedRootPath: 'src/generated/i18n',
    },
    graph: graph.value,
    catalogs: [parsed.value],
    configuration,
  });
  return compiled.value;
}

function contextFor(artifacts) {
  const catalog = artifacts.catalogs[0];
  return rt.createLocalizationContext({
    setup: {
      configuration: Object.freeze({
        generatedAbi: 'atlas-generated/1',
        sourceLocale: 'en-US',
        defaultLocale: 'en-US',
        locales: Object.freeze(['en-US']),
        aliases: Object.freeze({}),
        applicationContractFingerprint:
          artifacts.descriptor.applicationContractFingerprint,
        semanticRegistryFingerprint:
          artifacts.descriptor.semanticRegistryFingerprint,
        extensionDescriptors: Object.freeze([]),
        scopes: Object.freeze([
          Object.freeze({
            providerId: 'p',
            scopeId: 's',
            applicationContractFingerprint:
              catalog.applicationContractFingerprint,
            semanticRegistryFingerprint: catalog.semanticRegistryFingerprint,
            requiredExtensions: Object.freeze([]),
          }),
        ]),
      }),
      catalogSet: artifacts.descriptor,
      catalogLoaders: { 'p:s:en-US': () => Promise.resolve(catalog) },
    },
    bootstrapScopes: [Object.freeze({ providerId: 'p', scopeId: 's' })],
  });
}

async function perContextMs(messageCount, runs) {
  const artifacts = await artifactsFor(messageCount);
  await contextFor(artifacts).initialize(); // warm module init out of the measurement
  const start = process.hrtime.bigint();
  for (let run = 0; run < runs; run += 1) {
    await contextFor(artifacts).initialize();
  }
  return Number(process.hrtime.bigint() - start) / 1e6 / runs;
}

const small = await perContextMs(500, 10);
const large = await perContextMs(5000, 10);
const snapshotGrowth = large / Math.max(small, 0.001);

// A request pays for the request, not for the catalog. Constructing a context over a catalog ten
// times larger should cost about the same; anything proportional means the catalog is being
// re-admitted per request instead of once per process.
const SNAPSHOT_LIMIT = 3;
record(
  'request-scoped context construction is flat in catalog size',
  // Admission is memoised by content identity, so the catalog is verified once per process
  // rather than once per request.
  'pass',
  snapshotGrowth < SNAPSHOT_LIMIT,
  `10x catalog grew per-context cost ${snapshotGrowth.toFixed(1)}x (flat ~1x, limit ${SNAPSHOT_LIMIT}x); ` +
    `500:${small.toFixed(1)}ms 5000:${large.toFixed(1)}ms`,
);

/* ------------------------------------------------------------------ *
 * The shared formatter store must be bounded by its ceiling, not by    *
 * how many distinct option shapes a caller happens to ask for.         *
 * ------------------------------------------------------------------ */

/**
 * The standalone formatting functions' `Intl` cache was hoisted to module scope, which moves the
 * memory line rather than the speed line. A per-call
 * cache cannot leak, because it dies with the call; a process-wide one holds what it is given until
 * something evicts it.
 *
 * So the shape asserted is that growth does not follow the *variety* of the input. The store is
 * driven to its ceiling first (that fill is the baseline, and it is a fixed cost the design
 * accepts) and then given ten times the ceiling in further distinct locale-and-option pairs, none
 * of them repeating. A bounded store evicts and stays flat; an unbounded one keeps every one.
 *
 * Distinct *pairs* rather than distinct options, because the leak this guards against is content
 * driven: a route parameter or a user-supplied value reaching a locale or a formatting option is
 * what makes the variety unbounded in the first place, and a caller with one locale and four
 * option shapes was never at risk.
 *
 * Measured against the built package, both sides of it: 0.07 MiB with the bound in place, three
 * runs agreeing to 0.01, and 20.04 MiB with the eviction loop removed from
 * `FormatterCache.remember` and the package rebuilt. The limit sits at 4 MiB, about fifty times
 * the bounded reading and a fifth of the unbounded one, so it is not a number the noise can reach
 * and not one a real regression can hide under.
 */
if (typeof globalThis.gc === 'function') {
  const ceiling = rt.RUNTIME_LIMITS.formatterCacheEntries;
  const one = rt.decimal('1');
  const calls = [];
  build: for (const locale of ['en-US', 'en-GB', 'fr-FR', 'de-DE', 'ar-EG']) {
    for (const useGrouping of [true, false, 'always']) {
      for (let integers = 1; integers <= 21; integers += 1) {
        for (let least = 0; least <= 20; least += 1) {
          for (let most = least; most <= 20; most += 1) {
            calls.push([
              { locale },
              {
                useGrouping,
                minimumIntegerDigits: integers,
                minimumFractionDigits: least,
                maximumFractionDigits: most,
              },
            ]);
            if (calls.length >= ceiling * 11) break build;
          }
        }
      }
    }
  }

  for (let index = 0; index < ceiling; index += 1) {
    rt.formatNumber(one, calls[index][0], calls[index][1]);
  }
  globalThis.gc();
  globalThis.gc();
  const baseline = process.memoryUsage().heapUsed;
  for (let index = ceiling; index < calls.length; index += 1) {
    rt.formatNumber(one, calls[index][0], calls[index][1]);
  }
  globalThis.gc();
  globalThis.gc();
  const growth = process.memoryUsage().heapUsed - baseline;
  const STORE_LIMIT = 4 * 1024 * 1024;
  record(
    'the shared formatter store is bounded by its ceiling',
    'pass',
    growth < STORE_LIMIT,
    `${calls.length - ceiling} distinct locale/option pairs past a ceiling of ${ceiling} grew heap ` +
      `${(growth / 1024 / 1024).toFixed(2)} MiB (bounded ~0.07, unbounded ~20.0, limit ${STORE_LIMIT / 1024 / 1024} MiB)`,
  );
} else {
  record(
    'the shared formatter store is bounded by its ceiling',
    'pass',
    true,
    'skipped: run node with --expose-gc to measure heap growth',
  );
}

/* ------------------------------------------------------------ *
 * Memory must not accumulate across repeated locale switching.  *
 * ------------------------------------------------------------ */

if (typeof globalThis.gc === 'function') {
  const artifacts = await artifactsFor(500);
  const localization = contextFor(artifacts);
  await localization.initialize();
  for (let run = 0; run < 50; run += 1)
    await localization.changeLocale('en-US');
  globalThis.gc();
  const baseline = process.memoryUsage().heapUsed;
  for (let run = 0; run < 500; run += 1) {
    await localization.changeLocale('en-US');
  }
  globalThis.gc();
  const growth = process.memoryUsage().heapUsed - baseline;
  const MEMORY_LIMIT = 8 * 1024 * 1024;
  record(
    'repeated locale switching does not accumulate heap',
    'pass',
    growth < MEMORY_LIMIT,
    `500 switches grew heap ${(growth / 1024 / 1024).toFixed(1)} MiB (limit ${MEMORY_LIMIT / 1024 / 1024} MiB)`,
  );
} else {
  record(
    'repeated locale switching does not accumulate heap',
    'pass',
    true,
    'skipped: run node with --expose-gc to measure heap growth',
  );
}

/* --------------- */

const surprising = results.filter((result) => result.surprising);
const known = results.filter(
  (result) => result.expectation === 'known-fail' && !result.passed,
);

process.stdout.write(
  `\nCost budget: ${results.length - known.length - surprising.length}/${results.length} within budget` +
    `${known.length > 0 ? `, ${known.length} known defect(s) recorded` : ''}.\n`,
);

for (const result of surprising) {
  process.stdout.write(
    result.passed
      ? `\n${result.name}\n  now passes but is recorded as a known defect. It was fixed. Change its ` +
          `expectation to 'pass' in tools/verify-cost-budget.mjs so it guards the fix.\n`
      : `\n${result.name}\n  regressed. A cost changed shape; this is not a slow machine.\n`,
  );
}

if (surprising.length > 0) process.exitCode = 1;
