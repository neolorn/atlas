/**
 * Mutation testing, on a cadence and not in the gate.
 *
 * Atlas already does this by hand: 53 declared injections across `verify:assurance` and
 * `verify:assurance:runtime`, each one written the day a defect was fixed, costing 219s and 876s.
 * Over half the gate's stage time is mutation testing already. What it cannot be is exhaustive:
 * those 53 are the mutations somebody thought of, and the value of a general tool is the ones
 * nobody did.
 *
 * The cost is why this is not a stage. Counting the syntax Stryker's mutator list attaches to, over
 * source with comments and strings removed, there are roughly 36,000 sites across the two packages;
 * the suites are fast, but 36,000 mutants at a sustained twenty per second is still longer than the
 * entire gate. So: a workflow run on request, and a gate that stays a gate. While this
 * repository is private that workflow is not run at all and both halves are read locally;
 * `.github/workflows/mutation.yml` carries the arithmetic.
 *
 * `thresholds.break` stays null on purpose. A number chosen before the first run either passes
 * trivially or fails on arrival, and either way it is a number nobody measured. The first run's
 * job is to produce the survivors; the survivors' job is to become injections in the two
 * harnesses, which are what run on every push. A threshold, if it is ever set, comes after that.
 *
 * **Read the covered column, not the total.** The first run scored 20.83% total and 67.91%
 * covered, and the gap is 12,317 mutants in modules these two suites never execute at all:
 * `angular.ts`, `catalog-runtime.ts`, the router providers. Those are guarded by the consumer,
 * browser and injection gates, which Stryker is not running and cannot see. A total read as a
 * coverage figure for Atlas would be wrong by most of its value.
 *
 * ## The reading as it stands
 *
 * On the runner, at 18,051 mutants: 1h43m, 4,125 killed, 35 timed out, 1,865 survived, 12,026 with
 * no coverage, 69.05% covered. The same mutants on a 32-thread machine: 15m12s, 4,077 killed, 237
 * timed out, 1,711 survived, 71.60% covered. Prefer the runner's figure. The population is
 * identical and the scores are not, because 24 workers make mutants time out that four workers run
 * to a verdict, and a timeout is scored as a kill, so the local score is the inflated one.
 *
 * The survivors sit where the first reading found them, with `core/src/routing.ts` down from 625 to
 * 406 where the refusal tests below landed: `routing.ts` (406), `evaluator.ts` (359),
 * `localized-input.ts` (217), `formatting.ts` (213), `runtime-safety.ts` (167), `extensions.ts`
 * (153), `http/src/handler.ts` (73). Seven files hold 1,588 of the 1,865.
 *
 * ## The first reading of the report
 *
 * Kept because what follows it was derived by reading those survivors, not by counting them. Its
 * numbers are from before the refusal tests and describe a tree that is gone.
 *
 * On the runner: 17,765 mutants, 40m34s, 3,529 killed, 31 timed out, 1,888 survived, 12,317 with
 * no coverage. The survivors concentrate in seven files: `core/src/routing.ts` (625),
 * `evaluator.ts` (349), `parsing.ts` (217), `formatting.ts` (213), `runtime-safety.ts` (174),
 * `extensions.ts` (113), `http/src/handler.ts` (74).
 *
 * **What the reading found, and it is one thing.** Nearly all of it is guard-shaped code: a list of
 * conditions, each refusing input the rest of the library then trusts. A survivor in a list like
 * that means one clause can be deleted with the suite still green, which is the same thing as that
 * clause not existing. So the classification the report invites (equivalent, untested branch,
 * real gap) collapses for this codebase: an untested clause in a refusal *is* the real gap, and
 * the only genuinely equivalent survivors are message prose.
 *
 * **Equivalent, and they should not be read again: about 20 `StringLiteral` mutants in message
 * text.** Atlas asserts diagnostic codes and outcomes, never message wording. Deliberately, so
 * that improving a message is not a test change. Mutating the prose therefore cannot fail a test
 * and never will. The exclusion is not configured, because `StringLiteral` is also what mutates
 * `'.'`, `'..'`, `'http:'` and `'indexable'`, which are values the code compares and are exactly
 * the clauses worth guarding. The distinction is whether the literal is compared or printed, and
 * that is a judgement per site rather than a mutator to switch off.
 *
 * **Tested, and re-measured rather than claimed.** `route-parameters-and-x-default.test.ts` and
 * `routing-refusals.test.ts` were written against eleven functions carrying 222 survivors
 * and 185 uncovered mutants between them. Re-running `core/src/routing.ts` alone with them in
 * place: **407 down to 156**, and the uncovered share from 185 to 28. Per function, survived plus
 * uncovered: `validateRouteProjection` 65 to 16, `trustedOrigin` 37 to 3,
 * `createIntegerParameterCodec` 56 to 10, `projectRouteSeo`'s origin check 22 to 6,
 * `prerenderParameters` 18 to 5, the two x-default copies 58 to 15. Local timeouts run higher than
 * the runner's under thirty-one-way concurrency, so a few of those are timeouts rather than kills;
 * the uncovered figures are machine-independent and are the ones to trust.
 *
 * **Left, and this is the list rather than a summary of it.** In `core/src/routing.ts`, by line and
 * count: 1112 `typeof value === 'string'` (11), 1216 `path.length === 0` (11), 1285
 * `target.length === 0` (9), 1312 the query bound and escape check (8), 2250 and 2282 the request
 * context probes (8 each), 1325 the query-entry check (7), 1080 the localized segment bound (6),
 * 2114 the canonical URL join (6), 2295 the advertisable-status pair (6), 1070 `path.startsWith`
 * (5), 1273 `decodeBounded`'s bound (5), 1711 the redirect location join (5), 2638 the empty-prefix
 * branch (5), 3247 the prefix join (5). `parseTarget` remains the densest single function at 46
 * survivors: its clauses interact, so a case that trips one often trips another, and separating
 * them needs a fixture per clause rather than a list of addresses.
 *
 * Outside `routing.ts`, untouched by this pass and in report order: `evaluator.ts` 349,
 * `parsing.ts` 217, `formatting.ts` 213, `runtime-safety.ts` 174, `extensions.ts` 113,
 * `handler.ts` 74. Those are the next reading's purpose.
 */
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';

/**
 * The files the runtime and the toolkit each keep a copy of, read from the one list that names
 * them. A test asserts the copies are the same bytes and instrumenting a file changes its bytes, so
 * a twin left in the mutate set fails that test in the dry run and nothing is measured at all. That
 * happened twice, the second time because this list and the test's list were kept in step by a
 * comment. Derived here instead: a twin added to the list is excluded by having been added.
 *
 * Both copies are excluded, though only the runtime one is inside the globs below, so the rule
 * stated here is the rule whatever those globs grow to cover.
 */
const twinExclusions = JSON.parse(
  readFileSync(new URL('tools/twin-sources.json', import.meta.url), 'utf8'),
).twins.flatMap(({ runtime, toolkit }) => [`!${runtime}`, `!${toolkit}`]);

export default {
  packageManager: 'pnpm',
  testRunner: 'vitest',
  // Named rather than discovered. The default is a glob over `node_modules/@stryker-mutator/*`,
  // and under pnpm's layout that scan finds nothing from inside the sandbox: the failure it
  // produces is `no TestRunner plugins were loaded`, which reads like a missing install.
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'vitest.mutation.config.ts' },

  /**
   * The runtime package, every entry point, nothing generated, and not the toolkit.
   *
   * The runtime publishes secondary entry points beside `src/`, each with its own `src`, so the
   * second pattern covers those: the same reason a search here starts at `packages/` rather than
   * at `packages/runtime/src`. A generated file is data with a `.ts` extension, and
   * mutating a locale table produces thousands of mutants that say nothing about code anyone wrote.
   *
   * The toolkit is not here, and its slice has its own configuration next to this one. All 15,662
   * of its mutants do not finish: 4,301 of them in fifteen minutes with 96 timeouts, and both
   * packages together are 33,427 and were abandoned twice. The difference is not the mutant count,
   * which is comparable to this scope's 17,765; it is that a large share of the toolkit's 531-test
   * suite is related to any one mutant, so a mutant that hangs costs the full timeout against a
   * nineteen-second suite before it is scored. `stryker.toolkit.config.mjs` takes the part of it
   * worth reading and sets a timeout the numbers support.
   */
  mutate: [
    'packages/runtime/src/**/*.ts',
    'packages/runtime/*/src/**/*.ts',
    '!packages/runtime/**/*.generated.ts',
    ...twinExclusions,
  ],

  // What is not copied into the sandbox. `fixtures/` holds consumer applications with their own
  // toolchains and is not a workspace member; the rest is output, cache, or 414 MiB of portable
  // Node builds.
  ignorePatterns: [
    '.atlas',
    '.runtimes',
    'tmp',
    'dist',
    'fixtures',
    'coverage',
  ],

  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'tmp/mutation/index.html' },
  jsonReporter: { fileName: 'tmp/mutation/report.json' },
  tempDirName: 'tmp/mutation-sandbox',

  thresholds: { high: 80, low: 60, break: null },

  /**
   * Workers, capped below the default of one per logical thread.
   *
   * The default leaves a machine slower and less usable at the same time, which is not the trade it
   * looks like. Measured by loading this exact scope at each setting and sampling, for sixty
   * seconds, how long a ready thread waits for CPU and how long a fixed slice of arithmetic takes
   * once it has it:
   *
   * ```text
   * workers   cpu busy   wait p95   work p50   work p95
   *    idle       6.1%       4.82      23.04      23.65
   *      16      66.6%      14.50      25.17      43.52
   *      20      80.8%      14.80      26.61      41.86
   *      24      92.9%      14.89      30.29      56.39
   *      28      77.0%      16.86      59.37     168.04
   *      31      53.6%      20.18     109.41     241.80
   * ```
   *
   * Utilization peaks at 24 and then falls, so past that point the extra workers are not doing
   * work, they are getting in each other's way. The 24 row reproduced within 2% on a second sweep;
   * 26 was measured too and had already collapsed, to 53.4% busy and 94ms of work.
   *
   * 24 is also this processor's physical core count against 32 logical threads, which is a
   * correlation worth recording and not a mechanism that was proven. Memory was ruled out: roughly
   * 22 GiB stayed free at every loaded setting.
   *
   * The threshold is the RAIL response budget: an action a person takes costs the wait plus the
   * work, and 100ms is where a response stops feeling immediate. At 24 that sum is about 71ms. At
   * 31 it is about 262ms.
   *
   * Written as a cap over Stryker's own default rather than as a number, so that a machine with
   * fewer threads is unaffected and keeps the setting it was measured under. That default is
   * `cores <= 4 ? cores : cores - 1`, and it has to be spelled out rather than approximated as
   * `cores - 1`: on the two-core hosted runner those two expressions differ, one worker against
   * two, which would halve the runner and silently invalidate every timing recorded from it.
   */
  concurrency: Math.min(
    cpus().length <= 4 ? cpus().length : cpus().length - 1,
    24,
  ),

  // The default is 1.5x the measured run plus 5s. These suites are between one and twenty seconds
  // whole, so a single slow mutant is easily inside the noise of a busy machine, and a timeout is
  // reported as a killed mutant, which counts as detected and quietly flatters the score.
  timeoutFactor: 2,
};
