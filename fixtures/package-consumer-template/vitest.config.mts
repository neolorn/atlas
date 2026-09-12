/**
 * One worker, one file at a time, on every machine that runs this suite.
 *
 * `@angular/build:unit-test` defaults `isolate` to false, so spec files that share a worker share a
 * jsdom, and how many workers there are is decided by the core count. That made this suite's result
 * a property of the machine: green on 32 threads, red on the two a hosted runner has, with the same
 * commit and the same code. Pinning it to the sharing-heaviest arrangement makes the answer the
 * same everywhere, and makes it the strict one: a spec file that leaves state behind is caught by
 * the next file rather than by whichever machine happens to schedule them together.
 *
 * It costs nothing worth counting: the suite is a few seconds of tests inside a build that is not.
 */
export default {
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
};
