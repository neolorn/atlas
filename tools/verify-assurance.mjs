/**
 * Does the suite still fail when it should?
 *
 * A test that cannot fail is worse than an absent one: it reports a guarantee nobody is holding.
 * One was found here: the fixture built to prove Atlas honors a consumer's `paths` and strictness
 * kept passing when every one of those behaviors was removed, because it asserted on an outcome
 * flag and one severity while the regressions reported through another channel. The finding is not
 * that one assertion was wrong. It is that nothing was checking whether the checks work.
 *
 * So this gate removes a behavior and requires the named test to notice. Each entry names the
 * invariant in its own words, so a failure here says what stopped being guarded rather than only
 * that a string no longer matched.
 *
 * This is a declared list, not exhaustive mutation testing. It grows when a defect is fixed and the
 * fix deserves a guard that is itself guarded.
 *
 * Every injection here patches a module and runs one vitest file, which is why it is seconds rather
 * than minutes. That is a property of the invariant, not of the package: it holds for any module
 * whose import graph reaches no Angular symbol at runtime, so the runtime's pure modules belong
 * here too. `verify-assurance-runtime.mjs` keeps the ones that genuinely need a built package
 * inside a materialized consumer.
 *
 * `specs/12-verification.spec.md` section 9 states the rule this gate is: withdraw the behavior
 * a check guards and require the check to notice, because a check nobody has seen fail is
 * indistinguishable from one that cannot.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PATHS_OVERLAY = `    paths: {
      ...(request.compilerOptions?.paths ?? {}),
      ...Object.fromEntries(virtualPathEntries),
    },`;

const injections = Object.freeze([
  {
    id: 'consumer-paths-discarded',
    invariant:
      "Atlas overlays its #i18n specifiers on the consumer's own paths instead of replacing them.",
    source: 'packages/toolkit/src/static-analysis.ts',
    find: PATHS_OVERLAY,
    replace: `    paths: {
      ...Object.fromEntries(virtualPathEntries),
    },`,
    caughtBy: 'packages/toolkit/test/semantic-model.test.ts',
  },
  {
    id: 'consumer-paths-discarded-through-the-cli',
    invariant:
      "A project compiled the way the CLI compiles it still resolves the consumer's own path aliases.",
    source: 'packages/toolkit/src/static-analysis.ts',
    find: PATHS_OVERLAY,
    replace: `    paths: {
      ...Object.fromEntries(virtualPathEntries),
    },`,
    caughtBy: 'packages/toolkit/test/consumer-source-diagnostics.test.ts',
  },
  {
    id: 'strictness-imposed',
    invariant:
      "Atlas analyzes under the consumer's compiler options and never adds strictness of its own.",
    source: 'packages/toolkit/src/static-analysis.ts',
    find: PATHS_OVERLAY,
    replace: `${PATHS_OVERLAY}
    noUncheckedIndexedAccess: true,`,
    caughtBy: 'packages/toolkit/test/semantic-model.test.ts',
  },
  {
    id: 'missing-plural-categories-unreported',
    invariant:
      'A target locale that omits a plural category its rules require is reported (ATL1308).',
    source: 'packages/toolkit/src/semantic-model.ts',
    find: '    if (missing.length === 0) continue;',
    replace: '    if (missing.length >= 0) continue;',
    caughtBy: 'packages/toolkit/test/plural-coverage.test.ts',
  },
  {
    id: 'omitted-target-message-unreported',
    invariant:
      'A target catalog that omits a required message is reported (ATL1307).',
    source: 'packages/toolkit/src/semantic-model.ts',
    find: `        'ATL1307',`,
    replace: `        'ATL1306',`,
    caughtBy: 'packages/toolkit/test/target-completeness.test.ts',
  },
  {
    id: 'authored-bidi-admitted',
    invariant:
      'A bidirectional control that can reorder surrounding text is refused when a catalog is parsed.',
    source: 'packages/toolkit/src/catalog.ts',
    find: '      const violation = inspectAtlasAuthoredBidi(value);',
    replace: '      const violation = undefined as undefined;',
    caughtBy: 'packages/toolkit/test/bidi-policy.test.ts',
  },
  {
    id: 'stale-translation-restamped',
    invariant:
      'A translation whose source moved underneath it keeps its prior stamp and is reported stale.',
    source: 'packages/toolkit/src/translation-state.ts',
    find: '        if (prior === undefined || prior.target !== digest) {',
    replace: '        if (true) {',
    caughtBy: 'packages/toolkit/test/translation-state.test.ts',
  },
  {
    id: 'untrusted-input-coerced',
    invariant:
      'A validator checks that untrusted input is a string before any grammar reads it.',
    source: 'packages/toolkit/src/untrusted-text.ts',
    find: "  if (typeof value !== 'string') {",
    replace: '  if (false as boolean) {',
    caughtBy: 'packages/toolkit/test/untrusted-input.test.ts',
  },
  {
    id: 'translator-notes-dropped',
    invariant:
      'Authored description and context reach the translator as XLIFF notes.',
    source: 'packages/toolkit/src/xliff.ts',
    find: `  return notes.length === 0
    ? []
    : ['      <notes>', ...notes, '      </notes>'];`,
    replace: '  return [];',
    caughtBy: 'packages/toolkit/test/translator-guidance.test.ts',
  },
  {
    id: 'missing-recovery-root-unreported',
    invariant:
      'An owner that composes the application runtime without a recovery root is an error in generate and check.',
    source: 'packages/toolkit/src/compiler.ts',
    find: '    analysis?.selectsApplicationRuntime === true &&',
    replace: '    false &&',
    caughtBy: 'packages/toolkit/test/reachability-and-recovery.test.ts',
  },
  {
    id: 'unused-source-messages-unreported',
    invariant:
      'Source messages nothing reaches are reported as a grouped advisory.',
    source: 'packages/toolkit/src/compiler.ts',
    find: '    diagnostics.push(...unusedSourceMessages(graph.value, analysis));',
    replace: '    void unusedSourceMessages(graph.value, analysis);',
    caughtBy: 'packages/toolkit/test/reachability-and-recovery.test.ts',
  },
  {
    id: 'build-command-authors-manifest',
    invariant:
      'Only atlas init creates an owner manifest; build commands never author files.',
    source: 'packages/toolkit/src/project-host.ts',
    find: '  const packageManifest = await readPackageManifest(location.value);',
    replace:
      '  const packageManifest = await readPackageManifest(location.value, true);',
    caughtBy: 'packages/toolkit/test/multi-owner-workspace.test.ts',
  },
  {
    id: 'unknowable-route-subtree-named-from-the-root',
    invariant:
      'Routes below an address Atlas cannot know are left unnamed, never named as if they sat at the top of the application.',
    source: 'packages/toolkit/src/static-analysis.ts',
    find: `    parentPath: string | undefined,
    parentLazyEntries: readonly string[],`,
    replace: `    parentPath: string | undefined = '',
    parentLazyEntries: readonly string[] = [],`,
    caughtBy: 'packages/toolkit/test/route-identity.test.ts',
  },
  {
    id: 'pathless-route-subtree-invisible',
    invariant:
      'A pathless layout route is descended through, so the routes and lazy boundaries beneath it are still read.',
    source: 'packages/toolkit/src/static-analysis.ts',
    find: `      const ownPath =
        pathExpression === undefined
          ? ''`,
    replace: `      if (pathExpression === undefined) continue;
      const ownPath =
        pathExpression === undefined
          ? ''`,
    caughtBy: 'packages/toolkit/test/route-identity.test.ts',
  },
  {
    id: 'route-identity-collision-unreported',
    invariant:
      'Two addresses resolving to one identity are reported, and neither is projected.',
    source: 'packages/toolkit/src/static-analysis.ts',
    find: '    if (group.length > 1) {',
    replace: '    if (false && group.length > 1) {',
    caughtBy: 'packages/toolkit/test/route-identity.test.ts',
  },
  {
    id: 'generated-provider-unrecognized',
    invariant:
      'An application that composes the runtime through the generated provideLocalization() is recognized as one.',
    source: 'packages/toolkit/src/static-analysis.ts',
    find: `    resolved.name === 'provideLocalization' &&
    declaredIn(resolved, generatedRoot)`,
    replace: `    false &&
    declaredIn(resolved, generatedRoot)`,
    caughtBy: 'packages/toolkit/test/reachability-and-recovery.test.ts',
  },
  {
    id: 'provisional-overlay-omits-the-provider',
    invariant:
      'The overlay that resolves #i18n during analysis carries the provider an application composes through.',
    source: 'packages/toolkit/src/compiler.ts',
    find: "    provider: 'declaration',",
    replace: '    provider: false,',
    caughtBy: 'packages/toolkit/test/reachability-and-recovery.test.ts',
  },
  {
    id: 'consumer-route-field-ignored',
    invariant:
      "Route indexing reads the field the consumer named through withRouting, not one of Atlas's invention.",
    source: 'packages/toolkit/src/static-analysis.ts',
    find: '  const field = policy?.field ?? DEFAULT_ROUTE_INDEXING_FIELD;',
    replace: '  const field = DEFAULT_ROUTE_INDEXING_FIELD;',
    caughtBy: 'packages/toolkit/test/route-identity.test.ts',
  },
  {
    id: 'selected-message-group-unreachable',
    invariant:
      'A message group handed to a call counts as a use of every message in it, so messages a running program selects are not reported unused.',
    source: 'packages/toolkit/src/static-analysis.ts',
    find: '        } else if (identity === undefined && !isPropertyName && handedOff) {',
    replace: '        } else if (false) {',
    caughtBy: 'packages/toolkit/test/issue-pairing.test.ts',
  },
  {
    id: 'message-group-receiver-counts-as-use',
    invariant:
      'Walking through a group to reach one message is not a use of the rest of it; otherwise the unused-message advisory could never fire.',
    source: 'packages/toolkit/src/static-analysis.ts',
    find: '          ts.isShorthandPropertyAssignment(node.parent) ||',
    replace: '          true ||',
    caughtBy: 'packages/toolkit/test/issue-pairing.test.ts',
  },
  {
    id: 'formatting-regenerates-authored-catalogs',
    invariant:
      'Formatting edits the authored document; regenerating it from the semantic model deletes every comment in it.',
    source: 'packages/toolkit/src/project-host.ts',
    find: '    const formatted = formatAtlasCatalogSource(file.source, catalogOptions);',
    replace: `    const formatted = formatAtlasCatalogSource(
      formatAtlasCatalog(file.catalog),
      catalogOptions,
    );`,
    caughtBy: 'packages/toolkit/test/lossless-format.test.ts',
  },
  {
    id: 'success-path-never-inspects-severity',
    invariant:
      'A command that did what it was asked still fails when it found something at error severity.',
    // The success path returned 0 unconditionally, so `atlas check --require-complete` reported
    // `"status": "success"` while carrying ATL1310 at `severity: error`, and every later change
    // was verified by a gate that could not fail on the things it depended on.
    //
    // Returning false is the mutation because it is the shape the defect actually had: not a wrong
    // answer, an unasked question.
    source: 'packages/toolkit/src/diagnostics.ts',
    find: "  return diagnostics.some(({ severity }) => severity === 'error');",
    replace: '  return false;',
    caughtBy: 'packages/toolkit/test/gate-exit-code.test.ts',
  },
  {
    id: 'strict-freshness-opt-in-ignored',
    invariant:
      'The strict-freshness opt-in actually escalates the staleness advisory, rather than being parsed and dropped.',
    // The injection is the failure the invariant above names: a flag that is read but never
    // consulted. Pinning the severity to `warning` leaves the option, the flag and the plumbing all
    // present and makes the policy do nothing, which a test asserting only the on-case would pass.
    source: 'packages/toolkit/src/project-host.ts',
    find: "          severity: options.requireFreshOutput === true ? 'error' : 'warning',",
    replace: "          severity: 'warning',",
    caughtBy: 'packages/toolkit/test/strict-freshness.test.ts',
  },
  {
    id: 'numbering-system-dropped-when-formatting',
    invariant:
      'A number is rendered in the numbering system the context asked for, not in the locale default.',
    // `formatting.ts` and `parsing.ts` are the largest correctness surface in the runtime and
    // where every numbering-system finding has lived, and for a long time neither harness carried
    // a single injection naming either: every `source:` was `routing.ts`, `angular.ts`,
    // `localization.ts` or the router's public API.
    //
    // Dropping the numbering system is the regression that would actually happen, and it is
    // invisible to a self-consistent round trip: Atlas would render `1234` where `١٢٣٤` was asked
    // for, parse it back to 1234, and be wrong for every reader.
    source: 'packages/runtime/src/formatting.ts',
    //
    // Pointed at a call site rather than at the helper, and worth an injection of its own for
    // that reason. The *helper* is already covered by
    // `numbering-system-passed-as-an-option-again`, but that proves the helper, not that each of the
    // nine call sites in this file actually uses what the helper returns. This drops the tag at one
    // site while leaving the validation above it intact, which is exactly the defect found in
    // `evaluator.ts`: a site that validates the numbering system and then formats without it.
    find: `    const formatter = cache.number(formattingTag, {
      ...options,
    });
    return success(
      semantic,
      formatter.format(number),`,
    replace: `    const formatter = cache.number(context.locale, {
      ...options,
    });
    return success(
      semantic,
      formatter.format(number),`,
    caughtBy: 'packages/runtime/test/numeric-formatting.test.ts',
  },
  {
    id: 'numbering-system-passed-as-an-option-again',
    invariant:
      'A number range and a duration are rendered in the numbering system the context asked for.',
    // `NumberFormat.formatRange`, `formatRangeToParts` and `DurationFormat.format` accept
    // a `numberingSystem` option, ignore it, and then report through `resolvedOptions()` that they
    // honoured it. Atlas builds a `-u-nu-` tag instead; this mutation hands back the bare locale,
    // which is what passing the option amounted to.
    //
    // The validation is deliberately left intact, so what this removes is only the delivery. A test
    // that checked for the refusal alone would stay green.
    source: 'packages/runtime/src/evaluator.ts',
    find: `    return new Intl.Locale(locale, { numberingSystem }).toString();`,
    replace: `    return locale;`,
    caughtBy: 'packages/runtime/test/numeric-formatting.test.ts',
  },
  {
    id: 'unsupported-numbering-system-renders-anyway',
    invariant:
      'A numbering system this runtime has no data for is refused, not quietly replaced with the locale default.',
    // Neither the option form nor the extension form reports an unsupported
    // but well-formed value, both fall back and render, so without this check the caller asks
    // for digits that do not exist, is told nothing, and is shown different ones. Removing the
    // check restores exactly that silence.
    source: 'packages/runtime/src/evaluator.ts',
    find: `  if (!supportedNumberingSystems().has(numberingSystem)) return undefined;`,
    replace: `  if (false) return undefined;`,
    caughtBy: 'packages/runtime/test/numeric-formatting.test.ts',
  },
  {
    id: 'sign-marks-not-learned-from-the-locale',
    invariant:
      'A signed number can be read back in the locales whose sign the platform decorates with a formatting control.',
    // The defect this replaces was live, and it was not subtle: `Intl` writes U+061C, U+200E or
    // U+200F next to the sign in 27 of the 162 locales this ICU build has data for, Atlas
    // compared the front of the string against a bare minus, and so refused to render a negative
    // decimal in every one of them. Found by the differential on its first run.
    //
    // Emptying the learned set is the mutation because it is the regression that would actually
    // happen: someone deciding the marks are noise, or the derivation moving to a formatter that
    // does not emit them.
    //
    // The first runtime injection in this file rather than the runtime one. Nothing about it needs
    // Angular, so nothing about it needs a package build and a materialized consumer: it patches a
    // pure module and runs one vitest file.
    //
    // What that buys is not total gate time: placing it here rather than in the runtime gate is
    // -3s there and +4s here, a wash within the run-to-run noise. What it buys is that this
    // injection can be run *alone*, in about a second, against a package build plus a consumer
    // materialize plus the consumer suite for one over there. The reason is reachability rather
    // than throughput.
    source: 'packages/runtime/src/localized-input.ts',
    find: '        if (/\\p{Cf}/u.test(scalar)) signMarks.add(scalar);',
    replace: '        if (false) signMarks.add(scalar);',
    caughtBy: 'packages/runtime/test/numeric-differential.test.ts',
  },
  {
    id: 'integer-parameter-codec-reads-any-number',
    invariant:
      'An integer route parameter is a decimal spelling, not whatever `Number` will accept.',
    // The sibling of `identifier-parameter-codec-accepts-anything`, which lives in the slow harness
    // because the consumer's own article route exercises it. This one had no route and no test at
    // all: the first mutation run reported 56 mutants in `createIntegerParameterCodec` that nothing
    // reached, in a function exported from the primary entry point.
    //
    // Taking the pattern out does not make the codec accept everything, which is what makes this
    // the honest injection rather than a strawman. `Number.isSafeInteger` still holds, so what gets
    // through is narrower and worse: `1e3`, ` 1`, `0x10` and `''` become valid spellings of 1000,
    // 1, 16 and 0. Each is a second address for a record that already has one, and Atlas's own
    // canonicalizer will not redirect them: the codec it asks says they are correct.
    source: 'packages/runtime/core/src/routing.ts',
    find: [
      '      if (!/^-?[0-9]{1,64}$/u.test(value)) {',
      '        return Object.freeze({ ok: false });',
      '      }',
    ].join('\n'),
    replace: '      // The decimal spelling is not checked.',
    caughtBy: 'packages/runtime/test/route-parameters-and-x-default.test.ts',
  },
  {
    id: 'catalog-locale-accepts-an-extension',
    invariant:
      'A catalog locale identity carries no extension or private-use subtag, so one locale cannot become two catalogs.',
    // `en-US` and `en-US-u-ca-islamic` name the same language to every reader and different
    // catalogs to Atlas. The check is one line and nothing had ever watched it fail; the property
    // file that now does generates the tags rather than listing four of them, because the failure
    // is a class, any singleton subtag, and not a spelling.
    source: 'packages/toolkit/src/locales.ts',
    find: '  if (parts.slice(1).some((part) => part.length === 1)) {',
    replace: '  if (false) {',
    caughtBy: 'packages/toolkit/test/round-trip-properties.test.ts',
  },
  {
    id: 'uninstall-reverts-an-edited-entry',
    invariant:
      'Uninstall takes back only what Atlas wrote; an edited script or a repointed #i18n specifier is left alone and named.',
    source: 'packages/toolkit/src/project-host.ts',
    find: '      if (entries[specifier] === target) delete entries[specifier];',
    replace: '      if (true) delete entries[specifier];',
    caughtBy: 'packages/toolkit/test/uninstall.test.ts',
  },
  {
    id: 'uninstall-removes-authored-catalogs',
    invariant:
      "Authored catalogs survive an uninstall unless their removal is asked for by name; they are the consumer's content.",
    source: 'packages/toolkit/src/project-host.ts',
    find: '    options.catalogs === true ? await loadAtlasProject(options) : undefined;',
    replace: '    true ? await loadAtlasProject(options) : undefined;',
    caughtBy: 'packages/toolkit/test/uninstall.test.ts',
  },
  {
    id: 'template-usage-never-deferred',
    invariant:
      "A message used only in a component's template is deferred with the component that owns the template, rather than reading as eager because no module imports a .html file.",
    source: 'packages/toolkit/src/compiler.ts',
    find: `    const path = owningSource.get(usage.sourcePath) ?? usage.sourcePath;
    if (!deferredPaths.has(path)) eager.add(scopeId);`,
    replace: `    const path = usage.sourcePath;
    if (!deferredPaths.has(path)) eager.add(scopeId);`,
    caughtBy: 'packages/toolkit/test/template-reachability.test.ts',
  },
  {
    id: 'lazy-route-carries-no-scopes',
    invariant:
      'A route behind a lazy boundary carries the scopes it must have ready, so deferring a scope does not mean rendering a page whose text never arrives.',
    source: 'packages/toolkit/src/compiler.ts',
    find: '  const deferred = new Set(deferredSourcePaths);',
    replace: '  const deferred = new Set<string>();',
    caughtBy: 'packages/toolkit/test/template-reachability.test.ts',
  },
]);

function runTests(testFile) {
  const result = spawnSync(
    process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npx',
    process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npx', 'vitest', 'run', testFile]
      : ['vitest', 'run', testFile],
    {
      cwd: workspaceRoot,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true', NO_COLOR: '1' },
      maxBuffer: 8_388_608,
      timeout: 300_000,
    },
  );
  return result.status === 0;
}

const missed = [];
for (const injection of injections) {
  const path = resolve(workspaceRoot, injection.source);
  const original = await readFile(path, 'utf8');
  const occurrences = original.split(injection.find).length - 1;
  assert.equal(
    occurrences,
    1,
    `Injection ${injection.id} no longer matches ${injection.source}. The code moved; update the injection so the invariant stays checked rather than silently unchecked.`,
  );
  try {
    await writeFile(
      path,
      original.split(injection.find).join(injection.replace),
      'utf8',
    );
    const caught = !runTests(injection.caughtBy);
    process.stdout.write(
      `${caught ? 'caught ' : 'MISSED '} ${injection.id}\n          ${injection.invariant}\n`,
    );
    if (!caught) missed.push(injection);
  } finally {
    await writeFile(path, original, 'utf8');
    assert.equal(
      await readFile(path, 'utf8'),
      original,
      `Failed to restore ${injection.source} after injection ${injection.id}.`,
    );
  }
}

if (missed.length > 0) {
  process.stderr.write(
    `\n${missed.length} invariant(s) are not guarded by the test named for them:\n${missed
      .map(
        ({ id, invariant, caughtBy }) =>
          `  ${id}\n    ${invariant}\n    ${caughtBy} passed with the behaviour removed.\n`,
      )
      .join('')}`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `\nAssurance verified: ${injections.length} removed behaviours were each caught by the test named for them.\n`,
  );
}
