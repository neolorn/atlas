import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prove the browser assurance gate can fail.
 *
 * It could not. `verify-package-consumer-hydration.mjs` imports the consumer's built server bundle,
 * which calls Angular's `attachNodeGlobalErrorHandlers`; registering any `uncaughtException` or
 * `unhandledRejection` listener suppresses Node's default of printing the error and exiting
 * non-zero, and Angular's listeners only print. Every error escaping a `try` in that file (111
 * assertions were outside the one it has, plus every server and page callback, which no `try` could
 * have covered) was reported in full to a pipeline that read exit code 0 and moved on. It ran
 * green over a consumer built with the wrong locale set for two complete pipelines.
 *
 * That file now registers its own listeners after the import and exits non-zero from them. This
 * runs it twice with a deliberate escape of each class and watches it die, because a gate nobody
 * has seen fail is indistinguishable from a gate that cannot, and the difference between those two
 * states is not visible in any passing run.
 *
 * A third case covers the other way that file reported nothing: by not ending. It had no bound on
 * any stage and wrote nothing until it finished, so a hung run and a working run were the same
 * observation from outside. A one-millisecond stage budget makes the first stage overrun, and this
 * watches the run name that stage and die, and checks it was narrating its stages on the way,
 * because the bound and the narration are only useful together. A bound with nothing to read tells
 * you a run stopped; narration with no bound tells you where a run is forever.
 *
 * It is a prerequisite of `verify:browser-assurance` rather than a peer, so that a broken control
 * makes the gate report skipped, which is true, instead of passing on evidence nothing has
 * checked. It costs about a second: both escapes fire immediately after the import, before the
 * static file server opens or any browser launches.
 */

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verifier = resolve(
  workspaceRoot,
  'tools/verify-package-consumer-hydration.mjs',
);
const consumerName = process.argv[2] ?? 'package-consumer';

const escapes = Object.freeze([
  {
    mode: 'assertion',
    description:
      'an assertion failing at the top level, where 111 of them sit today',
  },
  {
    mode: 'rejection',
    description: 'a promise rejecting with nobody awaiting it',
  },
]);

function runVerifier(overrides) {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [verifier, consumerName], {
      cwd: workspaceRoot,
      env: { ...process.env, ...overrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('close', (code, signal) =>
      settle({ code, signal, stdout, stderr }),
    );
  });
}

for (const escape of escapes) {
  const result = await runVerifier({ ATLAS_ASSURANCE_SELF_TEST: escape.mode });

  // The whole point, stated as plainly as it can be: this must not be zero.
  assert.notEqual(
    result.code,
    0,
    `The browser assurance gate survived ${escape.description} and exited 0. Its own \`uncaughtException\` and \`unhandledRejection\` listeners are gone, shadowed, or no longer exit, so every assertion in that file is decorative until this passes again.`,
  );

  // And it must fail by reporting, not by dying somewhere unrelated on the way. A missing consumer
  // build would also produce a non-zero exit, and would prove nothing about the listeners.
  assert.ok(
    result.stderr.includes('Atlas browser assurance failed.'),
    `The gate exited ${result.code} for ${escape.description} without reporting a failure. That is a different fault from the one under test:\n${result.stderr}`,
  );
  assert.ok(
    result.stderr.includes('Self-test escape'),
    `The gate failed for ${escape.description}, but not on the injected escape:\n${result.stderr}`,
  );

  // Nothing after the escape ran. Without this, a build that failed at the import would satisfy
  // everything above while the listeners themselves were never reached.
  assert.ok(
    !result.stdout.includes('verified.'),
    `The gate reported its verification complete after ${escape.description}:\n${result.stdout}`,
  );
}

// The third silence: a run that does not end. One millisecond of stage budget makes the first
// stage overrun, so this exercises the bound itself rather than any assertion behind it.
const bounded = await runVerifier({ ATLAS_ASSURANCE_STAGE_TIMEOUT_MS: '1' });

assert.notEqual(
  bounded.code,
  0,
  `The browser assurance gate ran to completion with a one-millisecond stage budget, so no stage is bounded and a stage that never finishes never ends the run:\n${bounded.stderr}`,
);
assert.ok(
  bounded.stderr.includes('did not finish within 1ms'),
  `The gate exited ${bounded.code} under a one-millisecond stage budget without reporting a stage overrun, which is a different fault from the one under test:\n${bounded.stderr}`,
);
// And that it was saying where it was on the way there. A bound with nothing to read says only that
// a run stopped; this is the half that says what it stopped in.
assert.ok(
  /\[assurance\] \S/u.test(bounded.stderr),
  `The gate never announced a stage, so a run in progress still cannot be located:\n${bounded.stderr}`,
);
assert.ok(
  !bounded.stdout.includes('verified.'),
  `The gate reported its verification complete after a stage overrun:\n${bounded.stdout}`,
);

// The fourth silence: the block that reports a caught failure had never been run. Both escapes
// above die before the try that assembles it and the stage bound exits from its own timer, so
// nothing had ever read the browser rows, the violations or the page state a real failure reports.
const reported = await runVerifier({
  ATLAS_ASSURANCE_SELF_TEST: 'diagnostics',
});

assert.notEqual(
  reported.code,
  0,
  `The browser assurance gate survived a failure inside its own try block and exited 0:\n${reported.stderr}`,
);
assert.ok(
  reported.stderr.includes('Self-test escape'),
  `The gate exited ${reported.code} without reporting the injected failure, which is a different fault from the one under test:\n${reported.stderr}`,
);

// Every engine in the matrix, with how far it got. A row that enters the evidence on the way out,
// after it has passed, contributes nothing when it fails, and the block then describes the engines
// that succeeded while saying nothing about the one that did not. The three labels are written out
// here rather than read from the verifier, which cannot be imported without running it.
for (const label of ['Chromium', 'Firefox', 'WebKit']) {
  assert.ok(
    reported.stderr.includes(`"label": "${label}"`),
    `The failure block did not name the ${label} row, so a run that failed before that engine reported nothing about it:\n${reported.stderr}`,
  );
}
assert.ok(
  reported.stderr.includes('"outcome": "not started"'),
  `The failure block named the browser rows without saying how far each got:\n${reported.stderr}`,
);
assert.ok(
  !reported.stdout.includes('verified.'),
  `The gate reported its verification complete after a failure inside its own try block:\n${reported.stdout}`,
);

process.stdout.write(
  `Browser assurance fails when it should: ${escapes
    .map((escape) => escape.mode)
    .join(
      ' and ',
    )} escapes each ended the process non-zero after the consumer's server bundle installed Angular's log-only handlers, an overrunning stage ended it by name, and a failure inside the run reported every browser row.\n`,
);
