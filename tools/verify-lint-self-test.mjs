import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prove the lint stage can fail, and fail for the two reasons it exists for.
 *
 * A green linter is indistinguishable from a linter whose rules are off, whose files list matches
 * nothing, or whose type-aware rules silently degraded because the program it was pointed at did not
 * load the file. All three of those are configuration, all three are quiet, and none of them is
 * visible in a passing run, which is the same argument `verify-browser-assurance-self-test.mjs`
 * makes about a gate that had never been seen to fail and could not.
 *
 * The two reasons are the ones the stage was asked for. A floating promise is what the compiler
 * cannot see with every strictness flag Atlas already sets, and it needs types to detect at all, so
 * a run that reports it proves the rule is on *and* that the TypeScript program reached the file. An
 * import cycle is the other half: no compiler flag reports one, it is a property of the module graph
 * rather than of any file, and the module resolver has to be working for the graph to exist.
 *
 * It seeds real files in the real source tree and runs the real `lint` script, because a fixture
 * project with its own configuration would prove that fixture's rules are on. The stage runs in a
 * tree of its own, so writing tracked source here is a local act, and the files are removed whether
 * the run passes or not.
 */

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seedRoot = resolve(workspaceRoot, 'packages/runtime/src');

const seeds = Object.freeze([
  {
    name: 'lint-self-test-floating.ts',
    rule: '@typescript-eslint/no-floating-promises',
    why: 'a promise nobody awaited, which needs types to see',
    contents: `export async function settle(): Promise<void> {
  await Promise.resolve();
}

export function seedsAFloatingPromise(): void {
  settle();
}
`,
  },
  {
    name: 'lint-self-test-cycle-a.ts',
    rule: 'import-x/no-cycle',
    why: 'a cycle in the module graph, which no compiler flag reports',
    contents: `import { fromB } from './lint-self-test-cycle-b';

export function fromA(): string {
  return fromB();
}
`,
  },
  {
    name: 'lint-self-test-cycle-b.ts',
    contents: `import { fromA } from './lint-self-test-cycle-a';

export function fromB(): string {
  return fromA();
}
`,
  },
]);

const seedPath = (seed) => resolve(seedRoot, seed.name);

const removeSeeds = () => {
  for (const seed of seeds) rmSync(seedPath(seed), { force: true });
};

const runLint = () => {
  const windows = process.platform === 'win32';
  return spawnSync(
    windows ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm',
    windows ? ['/d', '/s', '/c', 'pnpm', 'run', 'lint'] : ['run', 'lint'],
    {
      cwd: workspaceRoot,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true', NO_COLOR: '1' },
      maxBuffer: 16_777_216,
      timeout: 600_000,
    },
  );
};

// Nothing here is allowed to run against a tree that already has them: a leftover seed from an
// interrupted run would make this pass without proving anything, and would make `lint` itself red.
for (const seed of seeds) {
  assert.ok(
    !existsSync(seedPath(seed)),
    `${relative(workspaceRoot, seedPath(seed))} is already there. This stage writes it and removes ` +
      `it; a copy left behind means an earlier run was killed between the two, and it has to go ` +
      `before this can prove anything.`,
  );
}

let result;
try {
  for (const seed of seeds) writeFileSync(seedPath(seed), seed.contents);
  result = runLint();
} finally {
  removeSeeds();
}

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
const tail = output.trimEnd().split('\n').slice(-40).join('\n');

assert.notEqual(
  result.status,
  0,
  `The lint stage passed with a floating promise and an import cycle in its own source tree. ` +
    `Whatever it is checking, it is not the two things it exists to check.\n` +
    `--- its last 40 lines ---\n${tail}`,
);

for (const seed of seeds.filter(({ rule }) => rule !== undefined)) {
  assert.ok(
    output.includes(seed.rule),
    `Lint failed, but not for ${seed.rule}: ${seed.why}. A failure for some other reason proves ` +
      `nothing about that rule, and this is the only place that rule is ever seen to fire.\n` +
      `--- its last 40 lines ---\n${tail}`,
  );
  assert.ok(
    output.includes(seed.name),
    `Lint reported ${seed.rule} but never named ${seed.name}, so it was reported somewhere else. ` +
      `The seeded file is the subject; anything else is a real finding this stage would be hiding.\n` +
      `--- its last 40 lines ---\n${tail}`,
  );
}

for (const seed of seeds) {
  assert.ok(
    !existsSync(seedPath(seed)),
    `${relative(workspaceRoot, seedPath(seed))} survived the run, which leaves tracked source ` +
      `modified in this tree.`,
  );
}

process.stdout.write(
  `Atlas lint self-test verified: ${seeds.length} seeded files turn the lint stage red, naming ` +
    `${seeds
      .filter(({ rule }) => rule !== undefined)
      .map(({ rule }) => rule)
      .join(' and ')}.\n`,
);
