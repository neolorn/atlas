'use strict';

/**
 * Records which artefacts a gate stage reads and which it writes, by watching `node:fs` from inside
 * every process the stage spawns.
 *
 * `tools/verify.mjs` schedules its stages on a graph derived from the artefacts each one declares.
 * This file is what checks those declarations: it runs inside every gate run, and a stage that
 * touched an artefact its declaration does not name turns the run red before green is declared.
 *
 * The declarations were measured with this file in the first place, and the hand-written `needs`
 * list they replaced disagreed with the measurement in twenty-three stages, always by declaring
 * less than was true. `verify:edit-cost` and `verify:cost-budget` both declared only
 * `verify:consumer`, and `verify:edit-cost` edits that consumer in place, so a scheduler trusting
 * the list would have run them against each other. Nothing in the list said the tree existed.
 *
 * Checking the declarations against the `needs` entries they came from would have been a check
 * drawn from the same source as its subject: it agrees by construction, and would have agreed
 * here right up to the point where it corrupted a consumer install.
 *
 * **Loaded with `--require` through `NODE_OPTIONS`, so it reaches child processes too.** A stage is
 * `pnpm run <id>`, which is a shell, which is `pnpm`, which is node, which spawns `ngc`, `vitest`,
 * `tsc` and more node. Patching `fs` in this process alone would observe almost nothing; the
 * environment variable is what makes the measurement cover the work.
 *
 * **What is recorded is the artefact, not the file.** A gate run touches millions of paths and the
 * graph needs about ten of them: which consumer tree, which `dist`, which report. Each process keeps
 * a deduplicated set of `<kind> <artefact>` pairs with a couple of example paths each, and appends
 * it once on exit. That is the difference between a few kilobytes and several gigabytes.
 */

const fs = require('node:fs');
const path = require('node:path');

const traceFile = process.env['ATLAS_TRACE_FILE'];
const workspaceRoot = process.env['ATLAS_TRACE_ROOT'];

/**
 * The launcher is not the stage, and it was being measured as one.
 *
 * A stage is spawned as `pnpm run <id>`, so the first node process in the tree is pnpm itself, and
 * pnpm reads `packages/runtime/package.json` and `packages/toolkit/package.json` to resolve the
 * workspace before it starts anything. Traced, that arrives as the stage reading `source:packages`:
 * an edge the stage does not have, from work it did not do. It is invisible in the twenty-seven
 * stages that declare that artefact for their own reasons, and it is the entire trace of the three
 * that do not: run directly under this tracer, all three of those stages produce an empty trace and
 * exit 0, and run through `pnpm` they produce exactly one line, that read, with pnpm's two manifests
 * as its examples.
 *
 * pnpm does not always re-read them, because it keeps workspace state and skips the scan when
 * that state is fresh, so the same three stages have reported no trace at all on some runs and
 * an undeclared read on others, from nothing they did differently. Two opposite verdicts,
 * neither about the stage.
 *
 * **A flag consumed by the first process that sees it.** `verify.mjs` sets it once per stage; this
 * runs in the launcher, deletes it from the environment before the launcher spawns anything, and
 * declines to instrument itself. Everything the launcher starts is the stage and is traced as
 * before, including the `pnpm install` a stage runs against a consumer tree, which is a real write
 * by a real stage. Identifying the launcher by its own script path was rejected: a package manager's
 * entry lives wherever it was installed, and a rule that reads correctly under corepack and silently
 * stops matching under a local install is a check that fails open.
 */
const launcher = process.env['ATLAS_TRACE_LAUNCHER'] === '1';
if (launcher) delete process.env['ATLAS_TRACE_LAUNCHER'];

if (!launcher && traceFile !== undefined && workspaceRoot !== undefined) {
  install(traceFile, workspaceRoot);
}

function install(traceFile, workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const observed = new Map();
  // Captured before anything below is wrapped, so writing the trace cannot re-enter the tracer.
  const appendFileSync = fs.appendFileSync.bind(fs);

  /**
   * The named artefacts the gate's stages hand to each other, longest prefix first so a consumer
   * tree is not swallowed by the directory that holds all three of them.
   *
   * Anything outside this list is deliberately not recorded. The graph is about what one stage
   * produces for another, and a stage reading its own source or a system temp file produces no edge.
   */
  const artefacts = [
    ['tmp/package-consumer-verification/package-consumer', 'consumer:package'],
    [
      'tmp/package-consumer-verification/angular-22.0.4-consumer',
      'consumer:angular-22.0.4',
    ],
    [
      'tmp/package-consumer-verification/lower-bounds-consumer',
      'consumer:lower-bounds',
    ],
    ['tmp/focused-package-consumer-verification', 'consumer:focused'],
    // `tmp/package-consumer-verification`, the directory that holds the first three,
    // is deliberately not one. The only thing any stage does to it is `mkdir` it before installing
    // its own subtree, and counting that made all three installs write one artefact, which is the
    // exact concurrency this graph exists to allow. A container is not what is in it.
    ['release', 'release:packages'],
    ['dist/runtime', 'dist:runtime'],
    ['dist/toolkit', 'dist:toolkit'],
    ['dist', 'dist:other'],
    ['packages', 'source:packages'],
    ['tools', 'source:tools'],
    ['specs', 'source:specs'],
    ['docs', 'source:docs'],
    // Vitest's results cache, one per suite. It is keyed on `sha1(projectName)` and every stage here
    // ran unnamed, so all of them shared `sha1("")` and overwrote each other's `results.json`; the
    // two suites now carry their own `cacheDir` and the two injecting stages keep the unnamed one.
    //
    // `node_modules/.vite-temp` is not listed. Vite transpiles the config into it under a name
    // carrying a timestamp and a random suffix, then removes it, so two concurrent runs share the
    // directory and never a file. The rest of `node_modules` is installed before the gate and read
    // by nearly every stage without being written by any, so treating it as an artefact would draw
    // an edge from everything to everything and prove only that the gate uses its dependencies.
    ['node_modules/.vite/toolkit', 'cache:vitest:toolkit'],
    ['node_modules/.vite/runtime', 'cache:vitest:runtime'],
    ['node_modules/.vite', 'cache:vitest:unnamed'],
    ['tmp', 'report:temp'],
  ].map(([prefix, name]) => [path.resolve(root, prefix), name]);

  const packagesPrefix = path.resolve(root, 'packages') + path.sep;

  const classify = (candidate) => {
    let resolved;
    try {
      resolved = path.resolve(String(candidate));
    } catch {
      return undefined;
    }
    if (!resolved.startsWith(root)) return undefined;
    // A package-local `node_modules` is an install and a build cache, never source. `ng-packagr`
    // writes its `tsbuildinfo` under `packages/runtime/node_modules/.cache`, which read as the build
    // stage modifying the source tree, and the source tree has exactly one writer in this gate,
    // the injecting stage, so a false write there is the one edge that must not be wrong.
    if (
      resolved.split(path.sep).includes('node_modules') &&
      resolved.startsWith(packagesPrefix)
    ) {
      return { name: 'cache:build', resolved };
    }
    for (const [prefix, name] of artefacts) {
      if (resolved !== prefix && !resolved.startsWith(prefix + path.sep))
        continue;
      // `tmp` holds several hundred working files beside the two reports the gate actually
      // hands between stages. Only the reports are artefacts; the rest is a directory two stages
      // happen to share, and counting it would draw an edge for every one of them.
      //
      // `package.json` is excluded by name. It is not a report and a manifest there would be a
      // mistake in itself, but every tool that starts inside a tree under this directory walks
      // upward looking for one: `npx`, which is what the READMEs' own quickstart says to run, so
      // `verify:document-blocks` probed for a file that does not exist and read as depending on a
      // report it never opens.
      if (name === 'report:temp') {
        const rest = path.relative(prefix, resolved);
        if (
          rest.includes(path.sep) ||
          !rest.endsWith('.json') ||
          rest === 'package.json'
        )
          return undefined;
      }
      return { name, resolved };
    }
    return undefined;
  };

  const record = (kind, candidate) => {
    if (typeof candidate !== 'string' && !Buffer.isBuffer(candidate)) return;
    const hit = classify(candidate);
    if (hit === undefined) return;
    const key = `${kind} ${hit.name}`;
    let entry = observed.get(key);
    if (entry === undefined) {
      entry = { kind, artefact: hit.name, count: 0, examples: [] };
      observed.set(key, entry);
    }
    entry.count += 1;
    if (entry.examples.length < 3) {
      const relative = path
        .relative(root, hit.resolved)
        .split(path.sep)
        .join('/');
      if (!entry.examples.includes(relative)) entry.examples.push(relative);
    }
  };

  /**
   * `open` decides read from write by its flags, and the flags are the only place that answer
   * exists. Everything containing `w`, `a` or `+` can modify the file; `r` alone cannot.
   */
  const writesUnder = (flags) => {
    if (flags === undefined) return false;
    if (typeof flags === 'number') {
      // O_WRONLY is 1 and O_RDWR is 2 on every platform Node supports; O_RDONLY is 0.
      return (flags & 3) !== 0 || (flags & fs.constants.O_CREAT) !== 0;
    }
    const text = String(flags);
    return text.includes('w') || text.includes('a') || text.includes('+');
  };

  /**
   * A wrapper has to be the function it replaces in every way callers use.
   *
   * `fs.realpath.native` and the `util.promisify.custom` symbols hang off these functions as own
   * properties, and a plain closure drops them: pnpm's `fs-extra` calls `fs.realpath.native`, and
   * losing it fails the stage with "is not a function" rather than mis-measuring it. Copying every
   * own property, descriptors included, is the difference between an instrument and an edit.
   */
  const patch = (host, name, kindOf, pathArgumentIndex = 0) => {
    const original = host?.[name];
    if (typeof original !== 'function') return;
    const traced = function traced(...args) {
      try {
        record(kindOf(args), args[pathArgumentIndex]);
      } catch {
        // A tracer that can throw is a tracer that changes what it measures.
      }
      return original.apply(this, args);
    };
    Object.defineProperties(traced, Object.getOwnPropertyDescriptors(original));
    try {
      host[name] = traced;
    } catch {
      // A read-only accessor on this host: leave it alone rather than fail the stage.
    }
  };

  const asRead = () => 'read';
  const asWrite = () => 'write';
  const byFlags = (flagsIndex) => (args) =>
    writesUnder(
      typeof args[flagsIndex] === 'object' && args[flagsIndex] !== null
        ? args[flagsIndex].flag
        : args[flagsIndex],
    )
      ? 'write'
      : 'read';

  for (const host of [fs, fs.promises]) {
    // `readdir`, `realpath` and `stat` are deliberately absent. Listing a directory or resolving a
    // path is not consuming what is in it, and the difference is not cosmetic: `vitest` walks the
    // tree looking for config and test files, so recording `readdir` made `test:runtime` appear to
    // read all three materialized consumer trees and every report. Edges that would have
    // serialized the whole gate to protect a dependency that does not exist. A read is a read of
    // content.
    for (const name of ['readFile', 'readFileSync', 'createReadStream']) {
      patch(host, name, asRead);
    }
    // `mkdir` is absent for the same reason `readdir` is, and it cost the same kind of false edge:
    // creating a directory produces nothing. Every file written inside it is recorded on its own, so
    // nothing is lost, and what is gained is that three consumer installs stop appearing to write
    // one artefact because each of them creates the directory that holds all three. Removing an
    // entry here can only remove edges, never invent one, which is why this is the safe direction.
    // Deleting is still a write: `rm` destroys content, `mkdir` only makes room for it.
    for (const name of [
      'writeFile',
      'writeFileSync',
      'appendFile',
      'appendFileSync',
      'rm',
      'rmSync',
      'rmdir',
      'rmdirSync',
      'unlink',
      'unlinkSync',
      'createWriteStream',
      'truncate',
      'truncateSync',
      'utimes',
      'utimesSync',
    ]) {
      patch(host, name, asWrite);
    }
    // Both ends of a move or a copy are touched, and the destination is the written one.
    for (const name of [
      'rename',
      'renameSync',
      'copyFile',
      'copyFileSync',
      'cp',
      'cpSync',
    ]) {
      patch(host, name, asRead, 0);
      patch(host, name, asWrite, 1);
    }
    patch(host, 'open', byFlags(1));
    patch(host, 'openSync', byFlags(1));
  }
  // `readFile`/`writeFile` take their flag in an options object; `open` takes it positionally. Both
  // shapes are covered above, and `writeFile` is unconditionally a write whatever its options say.

  const flush = () => {
    if (observed.size === 0) return;
    const lines = [...observed.values()]
      .map((entry) => JSON.stringify({ pid: process.pid, ...entry }))
      .join('\n');
    observed.clear();
    try {
      appendFileSync(traceFile, lines + '\n');
    } catch {
      // Losing a trace line is a worse measurement, not a broken build.
    }
  };
  process.on('exit', flush);
  // A stage that is killed on timeout still recorded what it did up to that point.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, flush);
  }
}
