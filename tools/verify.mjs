import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The gate, as a dependency graph rather than a list.
 *
 * *What was wrong with the list.* Thirty steps ran in the order they were written, and the order
 * encoded real dependencies (the consumer after the build, the browser rows after their self-test)
 * but it encoded them as adjacency, so nothing distinguished "must follow" from "happens to be
 * next". Every step paid for every step before it whether or not it read anything that step wrote,
 * and the hand-written `needs` list beside them described the order rather than the dependencies.
 * `verify:edit-cost` and `verify:cost-budget` both declared only `verify:consumer`, and
 * `verify:edit-cost` edits that consumer in place: a scheduler that trusted the list would have run
 * them against each other. Nothing in the list said the tree existed.
 *
 * *So the graph is measured, not transcribed.* `tools/trace-artefacts.cjs` rides `NODE_OPTIONS` into
 * every process a stage spawns and records which artefacts it reads and writes. Deriving the graph
 * from the existing `needs` entries instead would be a check drawn from the same source as its
 * subject, agreeing by construction right up to the point where it corrupted a consumer install.
 *
 * *And the file is the graph, not the trace.* Each stage declares what it reads and writes below,
 * and the edges are derived from those declarations. The trace is what checks them: every run is
 * traced, and a stage that touched an artefact its declaration does not name turns the run red after
 * it finishes and before green is declared. Tracing costs 1.0% of the run's wall time, so there is
 * no staleness bookkeeping and no way to run untraced.
 *
 * *Reads and writes are declared disjointly and a writer implicitly reads.* Declaring an artefact in
 * both places would be noise; every edge a writer needs is derived from the write alone.
 *
 * *Over-declaring is safe and under-declaring is not, which is the direction the check runs in.* A
 * declared artefact a stage never touches costs an edge that need not exist. An undeclared artefact
 * a stage does touch is a missing edge, which is a race, and that is the one the trace catches.
 *
 * *Every derived edge points backwards in the written order*, because a stage depends only on
 * writers and readers that precede it. So the graph can reorder nothing: `--serial` runs these
 * stages in exactly the order they appear here, and the concurrent run is the same order with the
 * waiting removed. That is what makes the two runs comparable stage for stage.
 *
 * `specs/12-verification.spec.md` section 1 is what the gate exists to satisfy: every shipped
 * capability verified in proportion to its risk, and nothing counted as evidence except a
 * check that ran.
 */

const DEFAULT_STEP_TIMEOUT_SECONDS = 900;

/**
 * `format:check`, `lint:self-test`, `lint` and `typecheck` are the first phase and prerequisites of
 * everything else, applied by the runner rather than written into each stage. A tree that does not
 * typecheck is a tree nobody should be measuring, and a formatting miss found four seconds in should
 * cost four seconds, not the hour the rest of this takes to prove a change that was already
 * correct. That happened: a new test file went unformatted into a run that spent an hour on browser
 * rows and consumer installs before printing a two-line prettier warning. Applying the gate in the
 * runner means a stage added later is covered on the day it lands.
 *
 * Three of the four are a chain rather than four peers, and the chain is the whole of what `needs`
 * says here. `lint` runs after the control that proves it can fail, for the reason
 * `verify:browser-assurance:self-test` runs before the browser gate: a broken control should make
 * what it controls report skipped, which is true, rather than pass on evidence nothing checked.
 * `typecheck` runs after `lint`: the two read the same program and cost about the same, and
 * the linter's finding is the more specific of the two.
 */
const steps = Object.freeze([
  {
    id: 'format:check',
    gate: true,
    reads: ['source:docs', 'source:packages', 'source:specs', 'source:tools'],
  },
  // Seeds a floating promise and an import cycle into its own copy of the source and requires the
  // lint stage to go red naming both rules. Its own tree, because it writes tracked source; a gate
  // stage, because what it controls is one.
  {
    id: 'lint:self-test',
    gate: true,
    privateTree: true,
    // The same program `typecheck` loads, so the same installed type dependencies under
    // `packages/*/node_modules`: a type-aware rule cannot answer without them.
    reads: ['cache:build', 'source:packages'],
    writes: ['source:packages'],
  },
  {
    id: 'lint',
    gate: true,
    reads: ['cache:build', 'source:packages'],
    needs: [
      {
        on: 'lint:self-test',
        why: 'A linter nobody has seen fail is indistinguishable from one whose rules are off.',
      },
    ],
  },
  // The only stage that reads a test file's types at all: vitest transpiles with esbuild, which
  // strips types without checking them, and `ngc` only compiles what an entry point imports.
  {
    id: 'typecheck',
    gate: true,
    reads: ['cache:build', 'source:packages'],
    needs: [
      {
        on: 'lint',
        why: 'The same program, about the same cost, and the more specific finding first.',
      },
    ],
  },
  { id: 'verify:locale-profile', reads: ['source:packages'] },
  // Cheap, and it runs before anything derives from a vendored file: a source that no longer matches
  // its recorded digest makes every downstream result meaningless rather than wrong. The empty list
  // is deliberate: it reads `standards/`, the vendored sources and their lock, which no stage
  // produces. The one ordering that matters is declared as an edge below, where a reason can be
  // written next to it.
  { id: 'verify:standards-sources', reads: [] },
  // Every tracked file, so every source artefact, plus the commit log, which is not an artefact any
  // stage writes. Nothing depends on it: it is cheap, and a hit is a writing fault rather than a
  // broken build, so there is no reason to hold any other stage behind it.
  {
    id: 'verify:sterilize',
    reads: ['source:docs', 'source:packages', 'source:specs', 'source:tools'],
  },
  // Reads the specifications and every file that can cite one. Cheap, depends on nothing, and
  // holds nothing behind it: a citation that leads nowhere is a writing fault in the same way a
  // dash is, and neither breaks a build.
  {
    id: 'verify:spec-links',
    reads: ['source:docs', 'source:packages', 'source:specs', 'source:tools'],
  },
  // Reads every tracked document and the paths they name. Cheap, depends on nothing, and holds
  // nothing behind it, for the same reason as the two above: a link that arrives nowhere costs a
  // reader their click rather than costing a build.
  {
    id: 'verify:doc-links',
    reads: ['source:docs', 'source:packages', 'source:specs', 'source:tools'],
  },
  { id: 'verify:person-names', reads: ['source:packages'] },
  // The two suites run at the same time, which is what made their shared vitest results cache worth
  // finding: both hashed the empty project name and overwrote each other's record. Each now has its
  // own `cacheDir`, so the artefacts below are genuinely separate rather than separated by schedule.
  {
    id: 'test:toolkit',
    reads: ['source:packages'],
    writes: ['cache:vitest:toolkit'],
  },
  // The runtime's pure modules: the ones whose import graph reaches no Angular symbol at runtime.
  // Everything else the runtime does is proven in the feature lab, against the built package,
  // because that is the only place a claim about wiring can be made at all. An invariant is
  // asserted here or there, never in both, so this does not become a second copy of the lab.
  {
    id: 'test:runtime',
    reads: ['source:packages'],
    writes: ['cache:vitest:runtime'],
  },
  // The first of three stages that mutate tracked source in place and restore it. Each gets a tree
  // of its own, so the mutation has no reader to be protected from and the barrier these three used
  // to be is not there to derive: they still write `source:packages`, but not the copy anything else
  // is reading. Restoring on the way out, including when it throws, remains the stage's own contract
  // and is checked there rather than here: a private tree makes a failure to restore harmless to
  // everyone else, which is not the same as making it correct.
  {
    id: 'verify:assurance',
    privateTree: true,
    writes: ['cache:vitest:unnamed', 'source:packages'],
  },
  {
    id: 'build',
    reads: ['source:packages'],
    writes: ['cache:build', 'dist:other', 'dist:runtime', 'dist:toolkit'],
  },
  {
    id: 'verify:packages',
    reads: ['dist:runtime', 'dist:toolkit', 'source:packages'],
  },
  // What gets published is a tarball, and until this existed nothing in the pipeline ever looked at
  // one. A release went out with a type declaration containing the runtime module's JavaScript while
  // the build output on disk was correct throughout.
  {
    id: 'verify:tarballs',
    reads: ['dist:runtime', 'dist:toolkit', 'source:packages'],
    writes: ['release:packages'],
  },
  // A scan that counts a scratch directory as its corpus holds exports "used" on files that are
  // about to be cleaned away, so this one reads the built declaration files instead.
  {
    id: 'verify:export-surface',
    reads: ['dist:runtime', 'dist:toolkit', 'source:packages', 'source:tools'],
  },
  // Reads the built schema rather than the source, so it waits for `build`, and it is the stage
  // that fails when a settable configuration key has no `atlas init` flag. `dist:toolkit` is the
  // input; `source:packages` is the checked-in table it compares against.
  {
    id: 'verify:cli-options',
    reads: ['dist:toolkit', 'source:packages'],
  },
  // Same shape and the same reason: the built table is the input, and the two checked-in copies
  // are what it re-renders. It also reads every `src` under `packages/`, to fail a documented code
  // that nothing raises.
  {
    id: 'verify:diagnostics-reference',
    reads: ['dist:toolkit', 'source:docs', 'source:packages'],
  },
  // The command line page is the built CLI's own help and the configuration page is the schema
  // staged beside it, so both wait for `build`. `source:docs` is what they are compared against,
  // and `dist:runtime` is where the entry point page reads what each entry publishes.
  {
    id: 'verify:docs-reference',
    reads: ['dist:runtime', 'dist:toolkit', 'source:docs', 'source:packages'],
  },
  // Reads the composable exports out of the built declarations and the guides out of `docs/`, so
  // it fails when a feature ships with no page telling a reader it exists.
  {
    id: 'verify:guide-coverage',
    reads: ['dist:runtime', 'source:docs'],
  },
  // Reads the built declaration files through the TypeScript checker, so it waits for `build`.
  // `source:tools` is the baseline it compares against, which lives beside it in `tools/`.
  {
    id: 'verify:doc-coverage',
    reads: ['dist:runtime', 'dist:toolkit', 'source:tools'],
  },
  {
    id: 'verify:angular-free-consumer',
    reads: ['dist:runtime', 'source:packages'],
  },
  {
    id: 'verify:handler-derivation',
    privateTree: true,
    writes: ['cache:vitest:unnamed', 'source:packages'],
  },
  // Empty on purpose: it reads `fixtures/semantic-analysis/`, which no stage produces.
  { id: 'verify:angular-analysis', reads: [] },
  {
    id: 'verify:node-compatibility',
    reads: ['dist:runtime', 'dist:toolkit', 'source:packages'],
  },
  // Empty on purpose: it reads no file at all. It probes the installed engines, Node's `Intl`
  // and the three Playwright browsers, which the lockfile binds rather than a stage.
  { id: 'verify:platform', reads: [] },
  {
    id: 'verify:consumer',
    reads: ['dist:runtime', 'dist:toolkit', 'source:packages'],
    writes: ['consumer:package'],
  },
  {
    id: 'verify:focused-consumers',
    reads: ['dist:runtime', 'dist:toolkit', 'source:packages'],
    writes: ['consumer:focused'],
  },
  {
    id: 'verify:angular-22.0.4',
    reads: ['dist:runtime', 'dist:toolkit', 'source:packages'],
    writes: ['consumer:angular-22.0.4'],
  },
  {
    id: 'verify:lower-bounds',
    reads: ['dist:runtime', 'dist:toolkit', 'source:packages'],
    writes: ['consumer:lower-bounds'],
  },
  // Edits the materialized consumer in place and restores it, asserting the restore was exact. It
  // declares the write, so everything that reads that tree is ordered around it, which under the
  // list was true only because it happened to be written here.
  {
    id: 'verify:edit-cost',
    reads: ['source:packages'],
    writes: ['consumer:package'],
  },
  { id: 'verify:cost-budget', reads: ['consumer:package', 'source:packages'] },
  // What a new project costs Atlas between `atlas init` and its second scope, run cold against the
  // installed toolkit rather than against the workspace. It reads that consumer and writes nothing
  // it does not create itself, under `tmp/cold-start`, which is nested and so is not an artefact
  // any other stage can see.
  //
  // Its own stage rather than a case inside `verify:packages`: that stage reads `dist/toolkit`, and
  // a staged package cannot run its own CLI. Nothing resolves its dependencies in place. The only
  // toolkit that can execute the six commands is the installed one, and that is a different input.
  { id: 'verify:cold-start', reads: ['consumer:package'] },
  // The published documents, assembled into applications and run. Every fenced block names the file
  // it is, and the READMEs' files are one consumer: the providers, the route table, the switcher,
  // both catalogs and the spec. It ends at the spec, so a README whose blocks compile into an
  // application that renders nothing is still red.
  //
  // Every page under `docs/` is its own consumer on a copy of that one, because a guide shows the
  // configuration its reader would have rather than one carrying every capability. That is the
  // stage's cost: the base installs and runs once, and the pages are built and tested four at a
  // time on copies of it.
  //
  // It reads the two distributables because the consumers install from them, and `docs` and
  // `packages` because the documents are the thing under test. Its own tree under `tmp` is nested,
  // so it is not an artefact any other stage can see.
  {
    id: 'verify:document-blocks',
    reads: ['dist:runtime', 'dist:toolkit', 'source:docs', 'source:packages'],
  },
  // The one check in this list whose cases Atlas did not write. It compiles each of the working
  // group's MessageFormat 2 cases with the installed toolkit and evaluates it through the built
  // runtime.
  // "What compiles, renders", as an invariant rather than as cases. Every option in the built-in
  // table, at every declared value, compiled by the installed toolkit and rendered by the built
  // runtime: nothing accepted may throw, and nothing accepted may render exactly as it would
  // without the option. Its cases are generated from the table both halves read, so a function that
  // gains an option contributes its cases on the day it lands.
  {
    id: 'verify:message-function-space',
    reads: ['consumer:package', 'source:packages', 'source:tools'],
  },
  {
    id: 'verify:message-format-conformance',
    reads: ['consumer:package', 'source:packages', 'source:tools'],
    writes: ['report:temp'],
    needs: [
      {
        on: 'verify:standards-sources',
        why: 'A suite from another revision tests another specification and reports the difference as a defect. No artefact passes between them, so no measurement can find this edge.',
      },
    ],
  },
  // Before the three browser rows rather than beside them, and a prerequisite of all three rather
  // than a peer. It watches the assurance verifier die on a deliberate escape, which is the only way
  // to know that file reports anything at all: importing the consumer's server bundle installs
  // Angular's log-only global error handlers, and for as long as they were the last word every
  // assertion outside that file's own `try` printed and exited 0. The gate ran green over a consumer
  // built with the wrong locale set, twice, and looked no different from a real pass.
  {
    id: 'verify:browser-assurance:self-test',
    reads: ['consumer:package', 'source:packages'],
  },
  // The three rows run alone: serial among themselves and not overlapped with anything else
  // either. This is the one exclusion that is declared rather than derived: they share no artefact,
  // and what they contend for is the machine's browsers, which no read or write records.
  //
  // Alone rather than merely serial, because that is what the evidence covers. The
  // `firefox-browser-row` arming failure measures 3 in 40, [0.026, 0.199], on the row run by
  // itself, and a rate measured under one load says nothing about the same row under another. A
  // browser row that started failing because six consumer installs were running beside it would
  // look exactly like the flake already being chased, and would be attributed to it. Letting these
  // overlap non-browser work costs a re-measured 40-set, not a change to this line.
  {
    id: 'verify:browser-assurance',
    reads: ['consumer:package', 'source:packages'],
    exclusive: true,
    needs: [
      {
        on: 'verify:browser-assurance:self-test',
        why: 'If the control stops proving what it proves, this reports skipped, the truth, rather than passing on evidence nothing has checked.',
      },
    ],
  },
  {
    id: 'verify:browser-assurance:angular-22.0.4',
    reads: ['consumer:angular-22.0.4', 'source:packages'],
    exclusive: true,
    needs: [
      {
        on: 'verify:browser-assurance:self-test',
        why: 'All three rows share the listeners the self-test exercises, so one run covers them.',
      },
    ],
  },
  {
    id: 'verify:browser-assurance:lower-bounds',
    reads: ['consumer:lower-bounds', 'source:packages'],
    exclusive: true,
    needs: [
      {
        on: 'verify:browser-assurance:self-test',
        why: 'All three rows share the listeners the self-test exercises, so one run covers them.',
      },
    ],
  },
  // Rewrites the built packages with `.atlas-package-refresh` siblings and re-hands them to the
  // consumer. Under the list it declared only `verify:consumer` and worked solely because it was
  // written second to last; the three writes below are why that placement was load-bearing.
  {
    id: 'verify:consumer-refresh',
    reads: ['source:packages'],
    writes: ['consumer:package', 'dist:runtime', 'dist:toolkit'],
  },
  // Last, and now derivably so: it writes source, `dist` and the consumer, so every stage above
  // reads something it replaces. It rebuilds the package and re-hands it once per injection, which
  // is 52% of the gate on its own and the reason the ceiling for this item is a fifth rather than a
  // half.
  {
    id: 'verify:assurance:runtime',
    privateTree: true,
    reads: ['cache:build'],
    writes: [
      'consumer:package',
      'dist:other',
      'dist:runtime',
      'dist:toolkit',
      'source:packages',
    ],
    // Measured at 564s, so the bound is a little over three times that.
    timeoutSeconds: 1800,
  },
]);

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Forward slashes, always. `NODE_OPTIONS` is parsed as a command line, so a quoted Windows path
// loses every backslash to escape processing and node preloads `F:ProjectsUnisonAtlastools...`,
// which fails every stage at once with a module-not-found from `internal/preload`. Windows accepts
// forward slashes everywhere; the quotes stay for a workspace path containing a space.
const tracerPath = resolve(workspaceRoot, 'tools/trace-artefacts.cjs')
  .split(sep)
  .join('/');
const runDirectory = resolve(workspaceRoot, 'tmp/verify-run');
// Logs, traces and the summary stay in the repository the engineer is sitting in, not in the
// worktrees, because the worktrees are removed at the end of the run and the evidence is the part
// worth keeping.
const treesRoot = resolve(workspaceRoot, 'tmp/verify-trees');
const serial = process.argv.includes('--serial');
const planOnly = process.argv.includes('--plan');
const resuming = process.argv.includes('--resume');
const keepTrees = process.argv.includes('--keep-trees');
const ledgerPath = resolve(workspaceRoot, 'tmp/verify-ledger.jsonl');

const git = (...args) =>
  execFileSync('git', args, { cwd: workspaceRoot, maxBuffer: 1 << 28 })
    .toString()
    .trim();

/**
 * What the gate proves is a commit, so what it runs on is a commit.
 *
 * Hashing every tracked file plus every untracked file git does not ignore would establish that a
 * resume is resuming the same thing, and it would be a reconstruction of what a commit already is.
 * It would also leave the gate proving something nobody can push: a working tree, which has moved
 * by the time the run finishes. Refusing a dirty tree takes the thing itself instead. **The hash the gate proved is the hash that gets pushed**, and there is no
 * step between them where the subject can change.
 *
 * This is also what lets the run happen somewhere else. A commit can be checked out into as many
 * worktrees as there are stages that need one, so editing continues in the tree the engineer is
 * sitting in while the gate proves the commit they made, and the three stages that mutate tracked
 * source mutate a copy nothing else can see.
 */
const requireCommittedTree = () => {
  const changes = git('status', '--porcelain');
  if (changes.length > 0) {
    throw new Error(
      'The gate proves a commit, and this tree has changes that are not in one:\n\n' +
        `${changes}\n\n` +
        'Commit them and run the gate on that commit. A run against a working tree proves a state ' +
        'that is not addressable and may not exist by the time it finishes.',
    );
  }
  return git('rev-parse', 'HEAD');
};

/**
 * One line of a stage's output that identifies which failure this was.
 *
 * The ledger exists to count occurrences of a recurring failure, and counting is only useful if two
 * entries can be compared. A thrown error's own first line is what distinguishes the browser row's
 * arming assertion from the same row's timeout, which is the distinction the flake work needs.
 */
const signatureOf = (output) => {
  const lines = output.split('\n').map((line) => line.trim());
  const named = lines.find(
    (line) =>
      /^[A-Za-z]*Error\b/u.test(line) ||
      line.includes('AssertionError') ||
      line.includes('did not finish within'),
  );
  const fallback = lines.filter((line) => line.length > 0).at(-1) ?? '';
  return (named ?? fallback).slice(0, 240);
};

// ---------------------------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------------------------

const position = new Map(steps.map((step, index) => [step.id, index]));
const stepById = new Map(steps.map((step) => [step.id, step]));
const readsOf = (step) => step.reads ?? [];
const writesOf = (step) => step.writes ?? [];

/**
 * Which tree a stage's artefacts live in.
 *
 * An artefact is only the same artefact if it is the same file, and two stages working in two
 * checkouts of the same commit do not share one. Scoping the graph's keys by tree is what makes the
 * three injecting stages stop being barriers: they mutate `source:packages` in a tree nothing else
 * reads, so the read-after-write and write-after-read edges to twenty-eight readers are not there to
 * derive. The declarations did not change and are still true: what changed is where they are true.
 */
const treeOf = (step) => (step.privateTree === true ? step.id : 'shared');
const scoped = (step, artefact) => `${treeOf(step)} ${artefact}`;

// The same question pointed at the gate rather than at a search. A typo in either id would leave
// `gates` empty and every stage would run exactly as it did before, with nothing to notice.
const gates = steps.filter(({ gate }) => gate === true).map(({ id }) => id);
if (gates.length !== 4) {
  throw new Error(
    `Expected four gate stages and found ${gates.length} (${gates.join(', ') || 'none'}). Without them every stage below runs whatever the cheap checks said.`,
  );
}

const dependencies = new Map(steps.map(({ id }) => [id, new Set()]));

for (const step of steps) {
  if (step.gate !== true)
    for (const id of gates) dependencies.get(step.id).add(id);
  for (const { on, why } of step.needs ?? []) {
    if (!position.has(on)) {
      throw new Error(
        `${step.id} declares a logical dependency on ${on}, which is not a stage.`,
      );
    }
    if (typeof why !== 'string' || why.length === 0) {
      throw new Error(
        `${step.id} declares a logical dependency on ${on} with no reason. A measured edge explains itself; an asserted one has to be written down.`,
      );
    }
    dependencies.get(step.id).add(on);
  }
}

/**
 * Three kinds of artefact edge, and all three are needed.
 *
 * Read-after-write is the obvious one. Write-after-write orders two producers of the same artefact.
 * Write-after-read, a producer waiting for the readers of what it is about to replace, is the
 * one a readers-writer lock gives and a "needs" list cannot express at all, and it is what keeps
 * `verify:consumer-refresh` from rewriting `dist` under the stages still reading it.
 */
const artefacts = new Map();
for (const step of steps) {
  for (const artefact of [...readsOf(step), ...writesOf(step)]) {
    if (!artefacts.has(scoped(step, artefact)))
      artefacts.set(scoped(step, artefact), { readers: [], writers: [] });
  }
  for (const artefact of readsOf(step))
    artefacts.get(scoped(step, artefact)).readers.push(step.id);
  for (const artefact of writesOf(step))
    artefacts.get(scoped(step, artefact)).writers.push(step.id);
}

for (const { readers, writers } of artefacts.values()) {
  const earlier = (a, b) => position.get(a) < position.get(b);
  for (const writer of writers) {
    for (const other of [...writers, ...readers]) {
      if (other !== writer && earlier(other, writer))
        dependencies.get(writer).add(other);
    }
  }
  for (const reader of readers) {
    for (const writer of writers) {
      if (writer !== reader && earlier(writer, reader))
        dependencies.get(reader).add(writer);
    }
  }
}

/**
 * Every derived edge points backwards in the written order, so a cycle can only come from a
 * hand-written `needs`. Finding one after the scheduler stalls would look like a hang, which is the
 * failure mode this whole file exists to remove, so it is found here instead.
 */
const visiting = new Set();
const visited = new Set();
const visit = (id, trail) => {
  if (visited.has(id)) return;
  if (visiting.has(id)) {
    throw new Error(`Dependency cycle: ${[...trail, id].join(' -> ')}`);
  }
  visiting.add(id);
  for (const dependency of dependencies.get(id))
    visit(dependency, [...trail, id]);
  visiting.delete(id);
  visited.add(id);
};
for (const { id } of steps) visit(id, []);

// `--plan` prints the graph this run would be scheduled on and stops. It is for reading the edges,
// not for deciding whether to check them: the drift check runs inside every gate and is not
// something a caller can ask for or skip.
if (planOnly) {
  const width_ = Math.max(...steps.map(({ id }) => id.length));
  for (const step of steps) {
    const listed = [...dependencies.get(step.id)].sort(
      (a, b) => position.get(a) - position.get(b),
    );
    const alone = step.exclusive === true ? ['<alone>'] : [];
    const tree = step.privateTree === true ? ['<own tree>'] : [];
    process.stdout.write(
      `${step.id.padEnd(width_)}  ${[...alone, ...tree, ...listed].join(' ') || '(nothing)'}
`,
    );
  }
  if (!resuming) process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// Running a stage
// ---------------------------------------------------------------------------------------------

const pnpmCommand =
  process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm';

// A stage's own child processes outlive `child.kill()` on Windows, where this runs: `pnpm` spawns
// node and node spawns browsers. Killing the tree is the difference between a bounded pipeline and
// a bounded first process with an unbounded orphan behind it.
const killTree = (child) => {
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
    });
    return;
  }
  child.kill('SIGKILL');
};

const safeName = (id) => id.replace(/:/gu, '-');

// ---------------------------------------------------------------------------------------------
// The trees
// ---------------------------------------------------------------------------------------------

/**
 * One worktree per scope, all of them at the commit under test.
 *
 * The shared tree is where the twenty-seven ordinary stages run, and the engineer's own checkout is
 * not it, and that is the point: editing continues there while the gate proves the commit. Each
 * injecting stage gets a tree of its own, so mutating tracked source is a local act with no reader
 * to protect from it.
 *
 * What a tree does not get from the checkout is provisioned rather than copied. `node_modules` is a
 * `pnpm install` that hardlinks from the store on the same volume, so it costs seconds and almost no
 * bytes. The portable Node builds under `.runtimes` are 414 MiB of ignored files, and the
 * compatibility verifier already takes a root from the environment, so every tree points at the one
 * copy instead of having its own.
 */
const nodeRuntimesRoot = resolve(workspaceRoot, '.runtimes/node');

const treePath = (tree) => resolve(treesRoot, safeName(tree));

// `git worktree remove` refuses these: "Filename too long", on a materialized consumer's own
// `node_modules/.pnpm` names, which already reach 304 characters before a worktree adds its prefix.
// Node removed a 1049-character path in a probe without complaining, so the removal is done here and
// git is only asked to forget the registration afterwards. The retries are for the handle a
// just-finished stage has not released yet, which arrives as EPERM on the root directory.
const removeTree = (path) => {
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 300,
  });
};

const runIn = (path, command, args) =>
  execFileSync(
    process.platform === 'win32' ? pnpmCommand : command,
    process.platform === 'win32' ? ['/d', '/s', '/c', command, ...args] : args,
    { cwd: path, stdio: 'pipe', maxBuffer: 1 << 28 },
  );

// A tree already at the right commit is reused rather than rebuilt, and that is what makes a resume
// a resume: the artefacts a passed stage produced (a built dist, a materialized consumer) live in
// the tree, not in the repository, so a run that threw them away would have to rebuild everything it
// claimed to have already proven. Which is why a red run keeps its trees.
//
// A tree is at a commit when its tracked content is that commit's content, not merely when its HEAD
// says so. A stage that dies between applying a mutation and restoring it leaves the mutation behind,
// and a run reusing that tree proves something other than the commit it names, which is the one
// thing this whole arrangement exists to guarantee. Measured, not supposed: `verify:assurance` killed
// mid-injection left `M packages/toolkit/src/static-analysis.ts` in its tree, and the resume that
// reused it failed on its own anchor, "the code moved", and would have failed there forever.
const treeState = (path, commit) => {
  if (!existsSync(path)) return { at: false, dirty: [] };
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path })
      .toString()
      .trim();
    if (head !== commit) return { at: false, dirty: [] };
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: path })
      .toString()
      .split('\n')
      .filter((line) => line.trim().length > 0);
    return { at: true, dirty };
  } catch {
    return { at: false, dirty: [] };
  }
};

// Restoring by name, never against the root: `git restore .` and its neighbours do not belong
// anywhere near a repository root, and what a dead stage leaves is a short list of named tracked
// paths. Anything
// else (an untracked stray, a rename) is a state this cannot describe precisely, so it is not
// guessed at: the tree is rebuilt instead. `dist`, `node_modules` and `tmp` are ignored and never
// appear here, so a `??` entry is something no stage should have left.
const restoreTree = (path, dirty) => {
  const named = [];
  for (const line of dirty) {
    if (line.startsWith('??') || line.includes(' -> ')) return false;
    named.push(line.slice(3).replace(/^"|"$/gu, ''));
  }
  if (named.length === 0) return false;
  try {
    execFileSync(
      'git',
      ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...named],
      { cwd: path },
    );
  } catch {
    return false;
  }
  process.stdout.write(
    `=== restored ${named.length} path${named.length === 1 ? '' : 's'} a dead stage left in ${basename(path)}: ${named.join(', ')}\n`,
  );
  return true;
};

// Both callers below ask the same question and must get the same answer, so they ask it here. True
// means the tree exists and its tracked content is the commit's, after a restore if one was needed
// and possible. The re-read is the point: a restore that did not work must not be mistaken for a
// clean tree.
const treeUsableAt = (path, commit) => {
  const state = treeState(path, commit);
  if (!state.at) return false;
  if (state.dirty.length === 0) return true;
  if (!restoreTree(path, state.dirty)) return false;
  return treeState(path, commit).dirty.length === 0;
};

const provisionTree = (tree, commit) => {
  const path = treePath(tree);
  if (treeUsableAt(path, commit)) return path;
  removeTree(path);
  // A run that died leaves its registrations behind, and `git worktree add` refuses a path that is
  // still registered even after the directory is gone. Pruning first makes a crashed run cost
  // nothing on the next one.
  git('worktree', 'prune');
  git('worktree', 'add', '--detach', path, commit);
  runIn(path, 'pnpm', ['install', '--frozen-lockfile']);
  return path;
};

const releaseTrees = (paths) => {
  for (const path of paths) removeTree(path);
  git('worktree', 'prune');
};

const runStep = (id, timeoutSeconds, root) =>
  new Promise((settle) => {
    const args = ['run', id];
    const commandArguments =
      process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm', ...args] : args;
    // Appended rather than assigned: a caller's own `NODE_OPTIONS` is theirs, and dropping it would
    // change what the gate measures without saying so.
    const nodeOptions = [process.env.NODE_OPTIONS, `--require "${tracerPath}"`]
      .filter((part) => part !== undefined && part !== '')
      .join(' ');
    const child = spawn(pnpmCommand, commandArguments, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptions,
        // Read and removed by the tracer in the first node process it reaches, which is `pnpm`
        // itself. Its workspace scan is the runner's work, not the stage's, and attributing it to
        // the stage gave three stages an undeclared read of `source:packages` on the runs where
        // pnpm happened not to skip that scan.
        ATLAS_TRACE_LAUNCHER: '1',
        // The trace goes to the repository, because the tree it describes is about to be removed.
        ATLAS_TRACE_FILE: resolve(runDirectory, `${safeName(id)}.jsonl`),
        // Traced against the tree the stage actually ran in, so a path resolves to the same
        // artefact name wherever it was touched. That is what makes the drift check mean the same
        // thing in a private tree as in the shared one.
        ATLAS_TRACE_ROOT: root,
        ATLAS_NODE_COMPATIBILITY_ROOT: nodeRuntimesRoot,
        // Temporary, and a deliberate trade against an instrument's own cost rather than a lapse.
        //
        // The five page-side wrappers behind this switch cover the hot paths (element scrolling,
        // focus, and the two selection methods) and they were turned off because their cost moved
        // the failure *rate*, which made them useless for measuring one. This hunt is not measuring
        // a rate. It is trying to catch one occurrence with the wrappers on, and for that a higher
        // rate is welcome. So they run on unattended gate runs, where the occurrences happen, and
        // this line comes out the moment one is caught with them installed.
        ATLAS_ASSURANCE_TRACE_CALLS: '1',
      },
    });

    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      const notice = `\n=== TIMEOUT ${id} after ${timeoutSeconds}s. Killing it; a stage that does not end is a failure that reports nothing.\n`;
      output += notice;
      process.stderr.write(notice);
      killTree(child);
    }, timeoutSeconds * 1000);
    // Captured to a file rather than streamed. Thirty stages interleaving on one console is not a
    // log, and the summary below reads the same as it did when they ran one at a time.
    const capture = (source) => {
      source.on('data', (chunk) => {
        output += chunk.toString();
      });
    };
    capture(child.stdout);
    capture(child.stderr);

    child.once('error', (error) => {
      clearTimeout(timer);
      output += `${error.message}\n`;
      settle({ code: 1, output });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      settle({ code: timedOut ? 1 : (code ?? 1), output });
    });
  });

// ---------------------------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------------------------

// Sized from what the machine reports rather than from a constant, so a smaller machine narrows the
// run instead of thrashing it.
const concurrency = serial ? 1 : Math.max(1, availableParallelism());

const commit = requireCommittedTree();
const summaryPath = resolve(runDirectory, 'summary.json');

/**
 * A resume re-runs what has no result on this tree, and nothing else.
 *
 * *What must re-run.* Every stage that failed or was skipped: a skipped stage never ran, so green
 * cannot mean anything about it. And every stage made stale by one of those: if a re-run stage
 * writes an artifact, its readers and its later co-writers have to run again against what it now
 * produces.
 *
 * *What must not.* Write-after-read edges are scheduling constraints and not staleness: a stage
 * that already passed is not running, so there is nothing left to protect it from. Following those
 * edges here would re-run the whole gate and call it a resume.
 *
 * *And a failed writer takes its co-writers with it.* A stage that failed partway through writing
 * an artifact leaves it in a state nothing has described, so every stage that writes that artifact
 * runs again to rebuild it from a known one. The tree digest cannot see this, a materialized
 * consumer is not tracked, so it is handled by the graph instead of assumed away.
 */
const carried = new Map();
let attempt = 1;
let originalFailures = [];
if (resuming) {
  if (!existsSync(summaryPath)) {
    throw new Error(
      `No previous run to resume: ${summaryPath} does not exist. A resume proves nothing on its own; run the gate first.`,
    );
  }
  const previous = JSON.parse(readFileSync(summaryPath, 'utf8'));
  if (previous.commit !== commit) {
    throw new Error(
      'That run proved a different commit, so resuming it would report a green nothing measured.\n' +
        `  that run: ${previous.commit}\n` +
        `  this one: ${commit}\n` +
        'Run the gate rather than resuming it.',
    );
  }
  attempt = (previous.attempt ?? 1) + 1;
  originalFailures = previous.originalFailures ?? previous.failures ?? [];

  const rerun = new Set(
    previous.stages
      .filter(({ status }) => status !== 'pass')
      .map(({ id }) => id),
  );
  for (const { id, status } of previous.stages) {
    if (status !== 'fail') continue;
    const step = stepById.get(id);
    for (const artefact of writesOf(step)) {
      // Scoped, like every other lookup into this map. A stage that died mid-write left one tree's
      // copy of an artefact in a state nothing has described, and only the stages working in that
      // tree can have read it.
      const { readers, writers } = artefacts.get(scoped(step, artefact));
      // Rebuilt from its first producer up to the stage that died mid-write, and every stage that
      // read it runs again because what it read is no longer what is on disk.
      for (const writer of writers) {
        if (position.get(writer) <= position.get(id)) rerun.add(writer);
      }
      for (const reader of readers) rerun.add(reader);
    }
  }
  for (const { id, status, seconds } of previous.stages) {
    if (!rerun.has(id)) carried.set(id, { status, seconds, output: '' });
  }
  if (planOnly) {
    process.stdout.write(
      `
resume would re-run ${rerun.size} of ${steps.length} stages:
`,
    );
    for (const step of steps) {
      if (rerun.has(step.id))
        process.stdout.write(`  ${step.id}
`);
    }
    process.exit(0);
  }
  for (const id of rerun) {
    rmSync(resolve(runDirectory, `${safeName(id)}.jsonl`), { force: true });
    rmSync(resolve(runDirectory, `${safeName(id)}.log`), { force: true });
  }
  process.stdout.write(
    `=== RESUME attempt ${attempt}, re-running ${rerun.size} of ${steps.length} stages\n`,
  );
  for (const { id, signature } of originalFailures) {
    process.stdout.write(`         original failure ${id}: ${signature}\n`);
  }
} else {
  rmSync(runDirectory, { recursive: true, force: true });
}
mkdirSync(runDirectory, { recursive: true });

const results = new Map(carried);
const running = new Set();
const startedAt = new Map();
let peakConcurrency = 0;
let wake = () => {};

const start = (step) => {
  running.add(step.id);
  peakConcurrency = Math.max(peakConcurrency, running.size);
  startedAt.set(step.id, Date.now());
  process.stdout.write(`=== RUN  ${step.id}\n`);
  runStep(
    step.id,
    step.timeoutSeconds ?? DEFAULT_STEP_TIMEOUT_SECONDS,
    treesInUse.get(treeOf(step)),
  ).then(({ code, output }) => {
    const seconds = Math.round((Date.now() - startedAt.get(step.id)) / 1000);
    writeFileSync(resolve(runDirectory, `${safeName(step.id)}.log`), output);
    results.set(step.id, {
      status: code === 0 ? 'pass' : 'fail',
      seconds,
      output,
    });
    running.delete(step.id);
    process.stdout.write(
      `=== ${code === 0 ? 'PASS' : 'FAIL'} ${step.id} (${seconds}s)\n`,
    );
    advance();
    wake();
  });
};

/**
 * A failing stage stops the stages that read what it was going to write, and nothing else. Its
 * siblings finish, every failure is reported, and the run exits 1 at the end rather than at the
 * first red, which is the difference between one answer per run and one answer per failure.
 */
const advance = () => {
  let changed = true;
  while (changed) {
    changed = false;
    let reserved = [...running].some(
      (id) => stepById.get(id).exclusive === true,
    );
    for (const step of steps) {
      if (results.has(step.id) || running.has(step.id)) continue;
      const required = [...dependencies.get(step.id)];
      const blockedBy = required.filter((id) => {
        const result = results.get(id);
        return result !== undefined && result.status !== 'pass';
      });
      if (blockedBy.length > 0) {
        process.stdout.write(
          `=== SKIP ${step.id} (requires ${blockedBy.join(', ')})\n`,
        );
        results.set(step.id, { status: 'skip', blockedBy, seconds: 0 });
        changed = true;
        continue;
      }
      if (required.some((id) => !results.has(id))) continue;
      if (reserved) continue;
      if (step.exclusive === true) {
        // Reserved from the moment it is ready, not from the moment it starts. Waiting for an idle
        // machine while later stages keep starting in front of it is a stage that never runs.
        reserved = true;
        if (running.size > 0) continue;
        start(step);
        changed = true;
        continue;
      }
      if (running.size >= concurrency) continue;
      start(step);
      changed = true;
    }
  }
};

// Provisioned before the clock starts, and reported separately, because a run's wall time is what
// the stages cost and folding setup into it would make two different runs incomparable.
const wanted = [...new Set(steps.map(treeOf))];

// Checked before anything is built, so a refusal is a refusal rather than a refusal that first
// leaves four worktrees behind.
//
// A resume carries forward the results of stages it does not re-run, and those results are claims
// about artefacts that live in the trees rather than here. If a tree is missing, the dist and the
// materialized consumer those passes were about went with it, and carrying the passes forward would
// report a green about files that no longer exist. Red runs keep their trees precisely so this does
// not happen; a resume that finds them gone has to be a run.
//
// A tree that would have to be rebuilt is the same loss arriving by a different route, so a resume
// refuses that too rather than rebuilding: the rebuild is what would destroy the artefacts.
if (resuming) {
  const missing = wanted.filter(
    (tree) => !treeUsableAt(treePath(tree), commit),
  );
  if (missing.length > 0) {
    throw new Error(
      `These trees were not left usable by the run being resumed: ${missing.join(', ')}.\n` +
        'Their artefacts (a built dist, a materialized consumer) went with them, or their source ' +
        'no longer is this commit and rebuilding them would take the artefacts with it, so the passes ' +
        'this resume would carry forward describe files that are no longer there. Run the gate.',
    );
  }
}

const provisionStartedAt = Date.now();
const treesInUse = new Map();
for (const tree of wanted) {
  process.stdout.write(`=== TREE ${tree}\n`);
  treesInUse.set(tree, provisionTree(tree, commit));
}
const provisionSeconds = Math.round((Date.now() - provisionStartedAt) / 1000);
process.stdout.write(
  `=== ${treesInUse.size} worktrees at ${commit.slice(0, 7)} in ${provisionSeconds}s\n`,
);

const runStartedAt = Date.now();
advance();
while (running.size > 0) {
  await new Promise((resolve_) => {
    wake = resolve_;
  });
}
const wallSeconds = Math.round((Date.now() - runStartedAt) / 1000);

if (results.size !== steps.length) {
  // Nothing is running and nothing became runnable. A cycle is caught above, so this is an
  // unsatisfiable resource, and a scheduler that quietly stops is the hang this file removed.
  const stalled = steps
    .filter(({ id }) => !results.has(id))
    .map(({ id }) => id);
  throw new Error(
    `Scheduler stalled with ${stalled.length} stages never run: ${stalled.join(', ')}`,
  );
}

// ---------------------------------------------------------------------------------------------
// The drift check: the trace against the declarations
// ---------------------------------------------------------------------------------------------

/**
 * The graph above is what the run was scheduled on. This is what the run actually did.
 *
 * A stage that read or wrote an artefact its declaration does not name has an edge nobody drew, and
 * the run goes red for it after finishing: before green is declared, and without hiding the
 * stage's own result, because the two are different findings.
 *
 * *Whether the tracer ran at all, first.* If it fails to load (a renamed file, a `NODE_OPTIONS` a
 * caller clobbered, a syntax error) every trace is empty, every comparison finds nothing, and
 * drift reads
 * as clean for the rest of the project's life. So the first thing checked is that stages which
 * declare reads produced a trace at all. A check that cannot fail has not passed.
 */
const drift = [];
const untraced = [];
for (const step of steps) {
  if (results.get(step.id).status !== 'pass') continue;
  const tracePath = resolve(runDirectory, `${safeName(step.id)}.jsonl`);
  const declared = {
    read: new Set([...readsOf(step), ...writesOf(step)]),
    write: new Set(writesOf(step)),
  };
  const seen = { read: new Set(), write: new Set() };
  const lines = existsSync(tracePath)
    ? readFileSync(tracePath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
    : [];
  for (const line of lines) {
    const entry = JSON.parse(line);
    seen[entry.kind]?.add(entry.artefact);
  }
  if (lines.length === 0) {
    if (declared.read.size > 0) untraced.push(step.id);
    continue;
  }
  for (const kind of ['read', 'write']) {
    for (const artefact of seen[kind]) {
      if (!declared[kind].has(artefact))
        drift.push(`${step.id} ${kind} ${artefact}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

const failed = steps.filter(({ id }) => results.get(id).status === 'fail');

const failures = failed.map(({ id }) => ({
  id,
  signature: signatureOf(results.get(id).output),
}));
if (originalFailures.length === 0) originalFailures = failures;

// Every attempt is an occurrence. A resume that passes does not erase the failure it resumed from,
// and a recurring failure is only measurable if each of its occurrences was written down.
appendFileSync(
  ledgerPath,
  `${JSON.stringify({
    at: new Date().toISOString(),
    mode: resuming ? 'resume' : serial ? 'serial' : 'graph',
    attempt,
    commit,
    failures,
  })}\n`,
);

for (const step of failed) {
  const tail = results.get(step.id).output.trimEnd().split('\n').slice(-25);
  process.stdout.write(
    `\n=== FAILURE ${step.id} (last ${tail.length} lines)\n`,
  );
  process.stdout.write(`${tail.join('\n')}\n`);
}

const label = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' };
const width = Math.max(...steps.map(({ id }) => id.length));
process.stdout.write('\n=== SUMMARY\n');
for (const { id } of steps) {
  const result = results.get(id);
  const detail =
    result.status === 'skip'
      ? `requires ${result.blockedBy.join(', ')}`
      : `${result.seconds}s`;
  process.stdout.write(
    `${label[result.status]}  ${id.padEnd(width)}  ${detail}\n`,
  );
}

if (untraced.length > 0) {
  process.stdout.write(
    `\n=== UNTRACED (${untraced.length})\n` +
      'These stages declare reads and produced no trace, so the drift check below saw nothing and\n' +
      'proves nothing. Fix the tracer before reading this run as evidence.\n',
  );
  for (const id of untraced) process.stdout.write(`  ${id}\n`);
}

if (drift.length > 0) {
  process.stdout.write(
    `\n=== GRAPH DRIFT (${drift.length})\n` +
      'Each line is an artefact a stage touched that its declaration in this file does not name.\n' +
      'The stage passed; the graph it was scheduled on is wrong. Add the artefact and re-run.\n',
  );
  for (const line of drift) process.stdout.write(`  ${line}\n`);
}

const counts = { pass: 0, fail: 0, skip: 0 };
for (const { id } of steps) counts[results.get(id).status] += 1;

const serialSeconds = steps.reduce(
  (total, { id }) => total + results.get(id).seconds,
  0,
);
process.stdout.write(
  `\n${resuming ? `resumed run (attempt ${attempt})` : serial ? 'serial run' : 'graph run'}: ` +
    `${wallSeconds}s wall, ${serialSeconds}s of stage time, ` +
    `peak ${peakConcurrency} of ${concurrency} concurrent\n` +
    `logs and traces: ${runDirectory}\n`,
);

writeFileSync(
  resolve(runDirectory, 'summary.json'),
  `${JSON.stringify(
    {
      mode: resuming ? 'resume' : serial ? 'serial' : 'graph',
      attempt,
      commit,
      failures,
      originalFailures,
      wallSeconds,
      stageSeconds: serialSeconds,
      peakConcurrency,
      concurrency,
      drift,
      untraced,
      stages: steps.map(({ id }) => ({
        id,
        ...results.get(id),
        output: undefined,
      })),
    },
    null,
    1,
  )}\n`,
);

const red =
  counts.fail > 0 || counts.skip > 0 || drift.length > 0 || untraced.length > 0;

// A green run has nothing left to say and its trees are 4 GiB of it, so they go. A red run keeps
// them: the failure is reproducible in the tree it happened in, and a resume needs the artefacts the
// passed stages left there (a dist, a materialized consumer), which live in the tree rather than
// in this repository. Throwing them away would make a resume rebuild everything it had just proven.
if (keepTrees || red) {
  process.stdout.write(
    `=== trees kept at ${treesRoot}${red ? ' (this run was red; a resume will reuse them)' : ''}\n`,
  );
} else {
  releaseTrees([...treesInUse.values()]);
}

/**
 * The verdict, last, and the only line in this summary that carries counts.
 *
 * A count is not a verdict. Printing `30 passed, 0 failed, 0 skipped` above the block that made
 * the run red states that the run passed in the one place anybody reads, and leaves a reader to
 * already know that untraced and drift are verdicts too. So counts appear only inside a verdict,
 * every reason is on the same line as the word RED, and nothing prints after it.
 */
process.stdout.write(
  red
    ? `=== RED  ${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped, ` +
        `${untraced.length} untraced, ${drift.length} drifted\n`
    : `=== GREEN  ${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped\n`,
);

process.exitCode = red ? 1 : 0;
