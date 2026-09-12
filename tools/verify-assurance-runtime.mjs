/**
 * Does the runtime's suite still fail when the runtime stops doing something?
 *
 * `verify-assurance.mjs` asks that question by injecting into a source file and running the
 * workspace vitest file named for the invariant, in seconds. The runtime's pure modules have such
 * tests, and their injections live in that file because they cost seconds there.
 *
 * What stays here is everything a workspace test cannot see: wiring, hydration, providers, the
 * document, the URL. Proving those means the built package inside the materialized consumer, so an
 * injection here has to rebuild the package, refresh the consumer's copy of it, and run the
 * consumer's own suite. That needs the consumer to exist, so this runs after `verify:consumer`
 * rather than as more rows in the other file's list.
 *
 * What the reach is worth is `route-scopes-not-derived` below. `derivedScopes` returning an empty
 * list disables scope loading on activation outright, and nothing a workspace test can reach moves:
 * the defect shows only in a consumer that renders. A guard nobody has watched fail is a claim
 * about the guard.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withOfflineStoreRemedy } from './offline-store.mjs';
import {
  refreshCommand,
  refreshConsumerPackages,
} from './refresh-consumer-packages.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const consumerRoot = resolve(
  workspaceRoot,
  'tmp/package-consumer-verification/package-consumer',
);

const injections = Object.freeze([
  {
    id: 'declared-numbering-system-never-reaches-a-message',
    invariant:
      'The numbering system an application declares reaches the numbers rendered inside its messages.',
    // This injection found a live defect rather than confirming one. `evaluator.ts` formatted
    // every `:number`, `:integer`, `:currency`, `:percent` and `:unit` placeholder with the bare
    // locale and never read `numberingSystem` at all, so an application declaring one through
    // `withFormattingContext()` had it honoured by the direct formatting API and dropped by every
    // number inside a message, which is where nearly all of an application's numbers are.
    //
    // It stayed invisible because the only lab context that set a numbering system asked `ar-EG`
    // for `arab`, its own default. Nothing crossed, so nothing could see it.
    //
    // This lives here rather than in the fast harness because the claim is about the channel: a
    // value written into a provider surviving composition, a locale change and the message
    // pipeline. A workspace test can build a `FormattingContext` and call a formatter; it cannot
    // ask whether the application's own declaration arrives.
    source: 'packages/runtime/src/evaluator.ts',
    find: `    formatter = environment.formatterCache.number(
      formattingTag,`,
    replace: `    formatter = environment.formatterCache.number(
      environment.formatting.locale,`,
  },
  {
    id: 'route-scopes-not-derived',
    invariant:
      'A route loads the scopes the generated table says it needs, without the application listing them.',
    // Moved out of the entry point by `e958d47`, and this pointer stayed behind. The gate has
    // been red ever since, which is the correct behaviour: an injection that no longer matches
    // is an invariant nothing is checking, and passing would have been the wrong answer.
    source: 'packages/runtime/router/src/route-localization.ts',
    // The whole body, and both parameters kept referenced. Taking the derivation out leaves the
    // lookup with no reader and the parameters with no use, and `noUnusedLocals` and
    // `noUnusedParameters` refuse to compile either, so the injected build failed rather than
    // the suite, which reports an invariant as unmeasurable rather than as unguarded. `void` is
    // what the injections below already use to say a symbol is still referenced and no longer
    // used, and it is the honest shape here too: this is the derivation switched off, which is
    // the defect that reached 0.3.0.
    find: [
      '  const entry = projection.generated.routes.find(({ id }) => id === routeId);',
      '  return entry?.scopes ?? Object.freeze([]);',
    ].join('\n'),
    replace: [
      '  void projection;',
      '  void routeId;',
      '  return Object.freeze([]);',
    ].join('\n'),
  },
  {
    id: 'locale-entry-only-for-known-addresses',
    invariant:
      'An address carrying no locale is sent to one whether or not a page exists at it.',
    source: 'packages/runtime/core/src/routing.ts',
    find: '        if (!policy.omitDefaultPrefix) {',
    replace: '        if (policy.omitDefaultPrefix) {',
  },
  {
    id: 'not-found-abandons-the-navigation',
    invariant:
      "A not-found commits its locale and lets the application's own routing answer, rather than throwing.",
    // The anchor is the statements the invariant is made of rather than one line out of them,
    // because a bare `return undefined;` is an ordinary line: six of them are in this file, and a
    // pointer matching six places points at none of them. Assembled from an array so the anchor
    // stays readable and needs no escaping.
    source: 'packages/runtime/router/src/route-localization.ts',
    find: [
      '      await this.localization.changeLocale(resolution.presentationLocale, {',
      "        mode: this.options.mode ?? 'coordinated',",
      '      });',
      '      return undefined;',
    ].join('\n'),
    replace: '      throw new RouteLocalizationError(resolution);',
  },
  {
    id: 'document-locale-not-maintained',
    invariant:
      "The document's `lang` and `dir` follow the committed locale without being asked to.",
    source: 'packages/runtime/src/angular.ts',
    find: '          hooks.push(new DocumentLocaleCommitHook(document));',
    replace: '          void DocumentLocaleCommitHook;',
  },
  {
    id: 'interaction-not-preserved',
    invariant:
      'Focus, selection and scroll survive a locale transition without being asked to.',
    // Named to the browser gate, because no other suite can see it. A locale switch has to happen
    // in an engine that actually scrolls, against an application that asked the Router to restore
    // scroll position: otherwise nothing moves, the hook restores what was never lost, and the
    // assertion passes whether Atlas acts or not. That is what this injection reported as an
    // unguarded gap until the feature lab enabled `scrollPositionRestoration` and the restore
    // moved behind `NavigationEnd`.
    suite: 'browser',
    source: 'packages/runtime/src/angular.ts',
    find: `          new InteractionPreservationCommitHook(
            document,
            isPlatformBrowser(platformId),
            inject(LocalizationInteractionRestore),
          ),`,
    replace: `          new InteractionPreservationCommitHook(
            document,
            false,
            inject(LocalizationInteractionRestore),
          ),`,
  },
  {
    id: 'locale-announcement-not-published',
    invariant:
      'A locale change is announced into a live region Atlas owns, with the application rendering nothing.',
    source: 'packages/runtime/src/angular.ts',
    find: `            new LocaleAnnouncementCommitHook(
              document,
              isPlatformBrowser(platformId),`,
    replace: `            new LocaleAnnouncementCommitHook(
              document,
              false,`,
  },
  {
    id: 'post-commit-effects-never-run',
    invariant:
      'Effects that must follow a successful commit (announcement, interaction restore) actually run after it.',
    source: 'packages/runtime/src/localization.ts',
    find: '          hook.committed?.(next.publicSnapshot);',
    replace: '          void hook;',
  },
  {
    id: 'failed-commit-is-not-rolled-back',
    invariant:
      'A coherence-critical effect that fails leaves the previous locale, URL, view and document state in place.',
    source: 'packages/runtime/src/localization.ts',
    find: '          hook.rollback?.(previous?.publicSnapshot);',
    replace: '          void hook;',
  },
  {
    id: 'locale-source-order-ignored',
    invariant:
      'Locale sources are consulted in the order the application declared, and the first answer wins.',
    source: 'packages/runtime/src/locale-resolution.ts',
    // Reversed rather than emptied, because an empty list falls through to the default locale and
    // a test could pass on that by coincidence. Reversing keeps every source in play and only
    // changes which one is believed.
    find: `    for (const source of this.context.localeSources ?? DEFAULT_LOCALE_SOURCES) {`,
    replace: `    for (const source of [
      ...(this.context.localeSources ?? DEFAULT_LOCALE_SOURCES),
    ].reverse()) {`,
  },
  {
    id: 'chosen-locale-is-not-remembered',
    invariant:
      'A committed locale change is written to the persistence stores the application configured.',
    source: 'packages/runtime/src/locale-resolution.ts',
    find: '    this.persistenceHighWater = snapshot.id;',
    replace:
      '    this.persistenceHighWater = snapshot.id;\n    if (stores.length >= 0) return;',
  },
  // The seven capability areas found to have tests but no mutation-verified coverage. Every one
  // was already exercised by the consumer suite; none was guarded, which is a different claim
  // and the one this gate exists to make.
  {
    id: 'overlay-roots-do-not-follow-the-locale',
    invariant:
      'Overlay content takes its language and direction from the committed locale, with the application wiring nothing.',
    source: 'packages/runtime/src/angular.ts',
    find: `  apply(snapshot: LocalizationSnapshot): void {
    this.adapter.apply(snapshot);
  }`,
    replace: `  apply(snapshot: LocalizationSnapshot): void {
    void snapshot;
  }`,
  },
  {
    id: 'overlay-adapter-outlives-its-request',
    invariant:
      'An overlay adapter is disposed with the request that created it.',
    // Separate from the injection above because the two fail in opposite directions: one never
    // applies, one never stops. On a server the second is the unrecoverable half: an undisposed
    // adapter carries one request's overlay roots into the next.
    source: 'packages/runtime/src/angular.ts',
    find: `  dispose(): void {
    this.adapter.dispose?.();
  }`,
    replace: `  dispose(): void {
    void this.adapter;
  }`,
  },
  {
    id: 'required-participants-not-awaited',
    invariant:
      'A participant registered as required is prepared before the locale commits, not alongside it.',
    source: 'packages/runtime/src/localization.ts',
    // Emptied through `slice` rather than replaced with a literal, so the expression keeps its
    // type and the coordinator is still consulted: only its answer is discarded.
    find: `    const requiredParticipants = this.participantCoordinator.required();`,
    replace: `    const requiredParticipants = this.participantCoordinator
      .required()
      .slice(0, 0);`,
  },
  {
    id: 'progressive-participants-never-start',
    invariant:
      'In progressive mode the primary UI commits first and the independent regions still run afterwards.',
    source: 'packages/runtime/src/localization.ts',
    find: `    const progressiveParticipants = this.participantCoordinator.progressive();`,
    replace: `    const progressiveParticipants = this.participantCoordinator
      .progressive()
      .slice(0, 0);`,
  },
  {
    id: 'registered-message-function-unreachable',
    invariant:
      'A message function the application registered is reachable from a message that calls it.',
    source: 'packages/runtime/src/extensions.ts',
    // An early return rather than a deleted lookup: the condition is not statically false, so the
    // rest of the method stays type-checked and the injection cannot be undone by the compiler.
    find: `  messageFunction(id: string): RuntimeMessageFunctionBinding | undefined {`,
    replace: `  messageFunction(id: string): RuntimeMessageFunctionBinding | undefined {
    if (id.length >= 0) return undefined;`,
  },
  {
    id: 'notification-ignores-its-message-kind',
    invariant:
      "A notification's message is evaluated according to its own result kind, so a plain message arrives as text.",
    source: 'packages/runtime/src/presentation.ts',
    find: `  const content =
    notification.message.resultKind === 'plain'
      ? localization.evaluateText(
          notification.message as PlainMessageHandle,
          notification.inputs ?? {},
        )
      : localization.parts(
          notification.message as MessageHandle & {
            readonly resultKind: 'structured';
          },
          notification.inputs ?? {},
        );`,
    replace: `  const content = localization.parts(
    notification.message as unknown as MessageHandle & {
      readonly resultKind: 'structured';
    },
    notification.inputs ?? {},
  );`,
  },
  {
    id: 'recovery-text-never-published',
    invariant:
      'When localization itself is unavailable, the recovery message the application supplied is published for rendering.',
    // The toolkit gate already refuses an owner that composes no recovery root
    // (`missing-recovery-root-unreported`). That is a build-time claim about the consumer. This is
    // the runtime half: the root is present and there is nothing for it to show.
    source: 'packages/runtime/src/localization.ts',
    // The message alone. The retry label beside it keeps publishing, so what the suite sees is a
    // recovery surface that came up with nothing to read, which is what the invariant's name says
    // happens, rather than a surface that is missing altogether.
    find: `        this.recoveryValue.set(
          this.recoveryText(this.options.recoveryMessageIdentity, locale),
        );`,
    replace: `        this.recoveryValue.set(undefined);`,
  },
  {
    id: 'superseded-write-overwrites-a-newer-choice',
    invariant:
      'A slow write for an abandoned locale cannot land after, and overwrite, the choice that replaced it.',
    source: 'packages/runtime/src/locale-resolution.ts',
    find: '        if (snapshotId < this.persistenceHighWater) {',
    replace: '        if (false) {',
  },
  {
    id: 'document-locale-withdrawal-ignored',
    invariant:
      '`withoutDocumentLocale()` actually stops Atlas writing to a document it was told it does not own.',
    // The other half of `document-locale-not-maintained`, and a separate injection because the two
    // fail in opposite directions: that one breaks the default, this one breaks the withdrawal, and
    // a suite that only asserts the default passes with the withdrawal welded shut. Withdrawal is
    // the reading a widget depends on, and a widget that rewrites its host page's `lang` is a defect
    // nothing throws for.
    source: 'packages/runtime/src/angular.ts',
    find: `        if (documentLocale === undefined) {
          hooks.push(new DocumentLocaleCommitHook(document));
        }`,
    replace: `        if (true) {
          hooks.push(new DocumentLocaleCommitHook(document));
        }`,
  },
  {
    id: 'identifier-parameter-codec-accepts-anything',
    invariant:
      'An identifier route parameter is checked against its pattern before it becomes a route parameter.',
    // A codec whose `parse` always succeeds is the shape this defect takes: nothing throws, every
    // address resolves, and `../etc` arrives as a route parameter with the application's own
    // not-found page never reached.
    //
    // It stays here rather than moving to the fast harness with its integer sibling, and the
    // difference is reachability rather than preference: the consumer's article route uses this
    // codec, so the consumer's own suite is what notices. The integer one had no route and no test
    // (56 mutants nothing reached, found by the first mutation run) and its injection is in
    // `verify-assurance.mjs`, named to the workspace file written for it. Tried here first, and it
    // reported MISSED: nothing in the consumer exercises an integer parameter at all.
    source: 'packages/runtime/core/src/routing.ts',
    find: '        pattern.test(value) ? { ok: true, value } : { ok: false },',
    replace: '        { ok: true, value },',
  },
]);

function run(command, args, cwd) {
  const windows = process.platform === 'win32';
  return spawnSync(
    windows ? (process.env.ComSpec ?? 'cmd.exe') : command,
    windows ? ['/d', '/s', '/c', command, ...args] : args,
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true', NO_COLOR: '1' },
      maxBuffer: 16_777_216,
      timeout: 600_000,
    },
  );
}

function shell(command, args, cwd) {
  return run(command, args, cwd).status === 0;
}

/**
 * A step this gate depends on rather than measures, asserted with what the child actually said.
 *
 * `shell` answers with a boolean because most of what it runs is a suite that is *expected* to
 * fail, and the failing is the measurement. These are the other kind (a build, an install, a
 * materialization) where a non-zero exit ends the run and the only useful thing left on the
 * screen is the reason. The boolean threw that away: the first Linux run failed on the refresh
 * below and reported one sentence of this file's own prose, with nothing from pnpm.
 */
function required(command, args, cwd, why) {
  requireOk(run(command, args, cwd), `${command} ${args.join(' ')}`, cwd, why);
}

/** The same report for a step that is defined, and so run, somewhere else. */
function requireOk(result, description, cwd, why) {
  if (result.status === 0) return;
  const tail = (stream) => {
    const text = String(stream ?? '').trimEnd();
    return text === '' ? '(nothing)' : text.split('\n').slice(-20).join('\n');
  };
  assert.fail(
    withOfflineStoreRemedy(
      `${why}\n` +
        `  ran: ${description}\n` +
        `  in: ${cwd}\n` +
        `  exit ${result.status ?? 'null'}` +
        `${result.signal === null || result.signal === undefined ? '' : `, killed by ${result.signal}`}` +
        `${result.error === undefined ? '' : `, ${String(result.error)}`}\n` +
        `--- its last 20 lines of stdout ---\n${tail(result.stdout)}\n` +
        `--- its last 20 lines of stderr ---\n${tail(result.stderr)}`,
    ),
  );
}

/** Hand the consumer the package that was just built. */
function refreshConsumer(why) {
  requireOk(
    refreshConsumerPackages(consumerRoot),
    refreshCommand,
    consumerRoot,
    why,
  );
}

/**
 * The suite that can observe the invariant, which is not always the same suite.
 *
 * Most of these are visible to the consumer's own tests. Scroll and focus are not: they need a
 * real browser moving a real page, so that injection names the browser gate instead. It costs a
 * browser run per injection, which is why it is named rather than assumed.
 */
function suitePasses(suite) {
  required(
    'pnpm',
    ['run', 'build'],
    workspaceRoot,
    'The workspace did not build with the injection applied, so nothing was proven. A `TS6133 ' +
      'is declared but its value is never read` here is this file to fix, not the runtime: ' +
      'Atlas compiles with `noUnusedLocals` and `noUnusedParameters`, so an injection that ' +
      'removes the only reader of a local or a parameter cannot compile. Reference it with ' +
      '`void`, the way the injections above do, or widen the replacement to take the reader ' +
      'out with it.',
  );
  refreshConsumer(
    'The materialized consumer did not take the rebuilt package.',
  );
  if (suite !== 'browser') return shell('pnpm', ['test'], consumerRoot);

  // The browser gate serves the consumer's already-built Angular bundle. Refreshing the package in
  // `node_modules` does not rebuild that bundle, so without this the browser would run the old
  // Atlas and every browser-named injection would report itself unguarded. Re-materializing
  // installs the injected build and rebuilds the application.
  //
  // Materializing is asserted rather than folded into the `&&` chain, and the reason is a false
  // result this gate actually produced. `verify:consumer` materializes *and* runs the suite, so a
  // `pnpm run verify:consumer` that dies in `rmdir` (which it does on Windows whenever
  // anything still holds the consumer directory) returns non-zero, and a non-zero suite is
  // what this function calls a catch. One run reported `deferred-content-hydrates-in-the-stale-locale`,
  // an injection since removed along with the directive it targeted, as caught on that basis;
  // run again with the two steps separated it was MISSED, which was the true answer and the finding
  // that ended the directive. A gate that cannot tell "the suite failed" from "the suite could not run" reports
  // coverage it does not have, which is the one thing it exists not to do.
  required(
    'pnpm',
    ['run', 'materialize:consumer'],
    workspaceRoot,
    'Materializing the consumer failed. That is an infrastructure failure, not a caught mutation, and it must stop the run rather than be counted as coverage.',
  );
  return (
    shell('node', ['./tools/verify-package-consumer.mjs'], workspaceRoot) &&
    shell('pnpm', ['run', 'verify:browser-assurance'], workspaceRoot)
  );
}

/**
 * The consumer has to exist before the first injection, and this stage is the only thing that can
 * be sure it does.
 *
 * Sharing a tree with `verify:consumer` makes it sure by accident, on the gate graph happening to
 * order them. Running in a tree of its own means nothing is here that this file did not put here,
 * which is the property that makes mutating tracked source safe, and it cuts both ways. So the
 * preparation is explicit: build, materialize, once, before the first injection rather than per
 * injection.
 *
 * Guarded by `existsSync` rather than run unconditionally, because the same file still has to work
 * when someone runs it by hand in a tree that already has a consumer, and that is the ~80s case.
 */
if (!existsSync(consumerRoot)) {
  process.stdout.write(
    'No materialized consumer in this tree; building and materializing one.\n',
  );
  required(
    'pnpm',
    ['run', 'build'],
    workspaceRoot,
    'The workspace did not build, so there is nothing to hand a consumer.',
  );
  required(
    'pnpm',
    ['run', 'materialize:consumer'],
    workspaceRoot,
    'Materializing the consumer failed before any injection was applied. That is an infrastructure failure and it must stop the run rather than be reported as coverage.',
  );
}

/** Guarded by nothing and not known to be: the failure this gate exists to report. */
const missed = [];
/** Guarded by nothing, recorded as such, and said out loud on every run. */
const known = [];
/** Recorded as a gap and no longer one, which means the record is what needs correcting. */
const closed = [];
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
    const caught = !suitePasses(injection.suite);
    const label = caught
      ? injection.knownGap === undefined
        ? 'caught '
        : 'CLOSED '
      : injection.knownGap === undefined
        ? 'MISSED '
        : 'known  ';
    process.stdout.write(
      `${label} ${injection.id}\n          ${injection.invariant}\n`,
    );
    // A recorded gap that starts being caught is a marker to delete, and saying so is the only
    // thing that stops the list becoming a place where findings go to be forgotten.
    if (caught && injection.knownGap !== undefined) closed.push(injection);
    if (!caught && injection.knownGap === undefined) missed.push(injection);
    if (!caught && injection.knownGap !== undefined) known.push(injection);
  } finally {
    await writeFile(path, original, 'utf8');
    assert.equal(
      await readFile(path, 'utf8'),
      original,
      `Failed to restore ${injection.source} after injection ${injection.id}.`,
    );
  }
}

// The consumer is left holding whichever build ran last, which is an injected one whenever this
// gate fails. Restored unconditionally so a later gate cannot inherit a package nobody meant to
// publish.
required(
  'pnpm',
  ['run', 'build'],
  workspaceRoot,
  'The workspace did not rebuild after the injections were restored.',
);
refreshConsumer(
  'The materialized consumer was left holding an injected build.',
);

if (known.length > 0) {
  process.stdout.write(
    `\n${known.length} recorded gap(s), guarded by nothing and known to be:\n${known
      .map(({ id, knownGap }) => `  ${id}\n    ${knownGap}\n`)
      .join('')}`,
  );
}

// A recorded gap that starts being caught is a marker to delete. Failing on it is what stops the
// list turning into a place findings go to be forgotten.
if (closed.length > 0) {
  process.stderr.write(
    `\n${closed.length} recorded gap(s) are now guarded. Delete the knownGap marker so the guard is required from here:\n${closed
      .map(({ id }) => `  ${id}\n`)
      .join('')}`,
  );
  process.exitCode = 1;
}

if (missed.length > 0) {
  process.stderr.write(
    `\n${missed.length} runtime invariant(s) are guarded by nothing:\n${missed
      .map(
        ({ id, invariant }) =>
          `  ${id}\n    ${invariant}\n    The consumer suite passed with the behaviour removed.\n`,
      )
      .join('')}`,
  );
  process.exitCode = 1;
} else if (closed.length === 0) {
  process.stdout.write(
    `\n${injections.length - known.length} of ${injections.length} runtime invariants are guarded by a suite that notices when they stop holding.\n`,
  );
}
