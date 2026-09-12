import base from './stryker.config.mjs';

/**
 * The toolkit's compiler and parser, and nothing else.
 *
 * The toolkit is not excluded from mutation testing on principle, and it never was. It is excluded
 * by arithmetic: all 15,662 of its mutants do not finish, and the reason is not the count, which is
 * comparable to the runtime's. It is that a large share of the toolkit's 531-test suite is related
 * to any one mutant, so a mutant that hangs costs the full timeout before it is scored, and the
 * suite it is timed against runs for nineteen seconds.
 *
 * So the slice is the part of the toolkit where a surviving mutant means the most and the covering
 * tests are cheapest: the semantic model and the compiler that drives it, and the message parser.
 * Three files, all pure. The I/O-bound modules stay out, which is where the project host, the
 * output host, and the file watching live.
 *
 * Two files a mutation run must never touch are absent by being unnamed rather than by exclusion:
 * `message-format-syntax.ts` and `message-function-options.ts` exist once in each package, and a
 * test reads both copies and asserts they are the same bytes. Instrumenting either copy changes its
 * bytes, so mutating one fails that test in the dry run and nothing is measured at all.
 *
 * ## The reading on the runner
 *
 * Four workers, three jobs, 2,735 mutants: 1,525 killed, 343 timed out, 463 survived, 404 with no
 * coverage, no errors. Per file, total then covered: `message-format.ts` 90.02 and 92.84,
 * `compiler.ts` 74.74 and 80.10, `semantic-model.ts` 56.63 and 73.72. The jobs are 1h37m, 2h15m
 * and 2h08m, six hours of job time inside 2h15m of wall because they run beside each other.
 *
 * **Prefer this one, and it is the lower one.** 343 timed out here against 538 locally, and a
 * timeout is scored as a kill, so the local figures were holding an unknown number of survivors
 * behind the clock. Releasing them moves every module down and `compiler.ts` furthest, 85.80
 * covered locally against 80.10 here. The 463 survivors are 54 more than the local run found, and
 * the mutants with no coverage are unchanged at 404 against 403, which is the half of the reading
 * that does not depend on the machine.
 *
 * `semantic-model.ts` is still where the next pass goes: 341 of the uncovered mutants and 297 of
 * the survivors are in it.
 *
 * ## The reading taken locally
 *
 * Kept because the analysis under it was derived by reading those survivors rather than counting
 * them, and because the pair is what shows the timeout effect.
 *
 * Measured locally, at the 24 workers the base configuration caps this machine to: 2,744 mutants
 * across the three files, 43 minutes 32 seconds, 1,394 killed, 538 timed out, 409 survived, 403
 * with no coverage, no errors. 70.41 percent total and 82.53 percent covered. Per file, total then
 * covered: `message-format.ts` 90.23 and 93.00, `compiler.ts` 80.24 and 85.80, `semantic-model.ts`
 * 57.66 and 75.20.
 *
 * **Read that score downward.** A timeout is scored as a kill, and 538 of the 2,744 timed out, so
 * the covered figure is a ceiling rather than a measurement: an unknown share of those is a
 * survivor the clock reached first. The 403 mutants with no coverage are the machine-independent
 * half of the reading, and 341 of them are in `semantic-model.ts`, which is also where 278 of the
 * 409 survivors are. That file is where the next pass goes.
 *
 * A second reading exists now, above, and the two together are what the timeout caveat rests on
 * rather than one measurement and an argument.
 */
export default {
  ...base,

  mutate: [
    'packages/toolkit/src/semantic-model.ts',
    'packages/toolkit/src/compiler.ts',
    'packages/toolkit/src/message-format.ts',
  ],

  /**
   * The timeout, derived from what these suites actually do rather than left at the default.
   *
   * Stryker gives each mutant `netTime * timeoutFactor + timeoutMS + overhead`, where `netTime` is
   * the measured time of the tests related to that mutant and `overhead` is measured separately.
   * The default `timeoutMS` of 5000 is therefore five seconds of pure slack on top of two terms
   * that are already measured, and across 939 tests in these two suites the median test is 0.84ms,
   * the p90 is 306ms and the p99 is 2.7s. For the overwhelming majority of mutants the flat term is
   * the entire timeout, so a hanging mutant costs about 5.7s to score when the work it interrupted
   * was under a millisecond.
   *
   * 1000ms instead. What the flat term has to cover is run-to-run variance, since overhead is
   * counted already and the tests themselves are scaled by the factor. Measured variance under a
   * fully loaded machine is 1.31x, so `timeoutFactor: 2` inherited from the base carries it with
   * margin, and 1000ms is still more than a thousand times the median test and three times the p90.
   * A hanging mutant now costs about 1.7s rather than 5.7s.
   *
   * Being too aggressive here is not a neutral error. A timeout is reported as a killed mutant, so
   * an impatient timeout counts real survivors as detected and flatters the score. That is why the
   * factor is not reduced alongside the flat term: the term that was wrong was the one measuring
   * nothing.
   */
  timeoutMS: 1000,

  htmlReporter: { fileName: 'tmp/mutation-toolkit/index.html' },
  jsonReporter: { fileName: 'tmp/mutation-toolkit/report.json' },
  tempDirName: 'tmp/mutation-toolkit-sandbox',
};
