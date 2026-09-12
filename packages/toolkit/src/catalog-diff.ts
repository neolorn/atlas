import type { AtlasCatalog } from './catalog.js';
import {
  digestAtlasCanonicalJson,
  type AtlasCanonicalJsonValue,
} from './canonical-json.js';
import type { AtlasProjectConfiguration } from './configuration.js';
import { atlasFailure, atlasSuccess, type AtlasResult } from './diagnostics.js';
import {
  analyzeAtlasCatalogSet,
  type AtlasSemanticGraph,
  type AtlasSemanticMessage,
} from './semantic-model.js';
import { compareCodePoint } from './sorted-records.js';

/**
 * What happened to one message between two versions of a project.
 *
 * Seven cases rather than added, removed and changed, because a translation team needs to tell them
 * apart: a changed source invalidates every translation of it, a changed translation invalidates
 * nothing, and a changed contract is a code change as well as a wording one.
 */
export type AtlasCatalogDiffKind =
  | 'added'
  | 'removed'
  | 'identity-contract-changed'
  | 'source-changed'
  | 'translation-changed'
  | 'stale-source'
  | 'fallback-impact';

/** One side of a comparison: a project's configuration and its catalogs at one moment. */
export interface AtlasCatalogDiffSnapshot {
  /** The configuration in force, which is what says which locales are expected. */
  readonly configuration: AtlasProjectConfiguration;
  /** The catalogs as they stood. */
  readonly catalogs: readonly AtlasCatalog[];
}

/**
 * A message that was renamed, stated so the comparison does not read it as a deletion and an
 * addition.
 *
 * Without it a rename throws away every translation of the message, because nothing in the two
 * snapshots says the new identity is the old one under another name.
 */
export interface AtlasCatalogIdentityMove {
  /** What it was called before. Must exist in the earlier snapshot. */
  readonly from: string;
  /** What it is called now. Must exist in the later one. */
  readonly to: string;
}

/** What to compare: two snapshots, and any renames between them. */
export interface AtlasCatalogDiffRequest {
  /** The earlier state. */
  readonly before: AtlasCatalogDiffSnapshot;
  /** The later state. */
  readonly after: AtlasCatalogDiffSnapshot;
  /**
   * The messages that were renamed rather than replaced.
   *
   * Each identity may appear once on each side. A move naming something absent from its snapshot
   * fails the comparison rather than being ignored.
   */
  readonly identityMoves?: readonly AtlasCatalogIdentityMove[];
}

/** One thing that changed, and enough about it to act on without reading the catalogs again. */
export interface AtlasCatalogDiffEntry {
  /** What happened. */
  readonly kind: AtlasCatalogDiffKind;
  /** Which message, by its identity in the later snapshot. */
  readonly identity: string;
  /** What it was called before, on an entry that came from a rename. */
  readonly previousIdentity?: string;
  /** Which locale, on a change that is to one locale rather than to the message. */
  readonly locale?: string;
  /** A digest of what it was, absent when it did not exist before. */
  readonly beforeFingerprint?: string;
  /** A digest of what it is, absent when it no longer exists. */
  readonly afterFingerprint?: string;
}

/** Everything that changed between two snapshots, in a stable order. */
export interface AtlasCatalogDiff {
  /** The shape's version stamp. */
  readonly profile: 'atlas-semantic-catalog-diff/1';
  /** The changes, sorted, so two runs over the same pair produce the same list. */
  readonly entries: readonly AtlasCatalogDiffEntry[];
  /** A digest of the whole comparison, for recognizing one that has already been acted on. */
  readonly digest: string;
}

function messageMap(
  graph: AtlasSemanticGraph,
): ReadonlyMap<string, AtlasSemanticMessage> {
  return new Map(
    graph.scopes.flatMap((scope) =>
      scope.messages.map((message) => [message.identity, message] as const),
    ),
  );
}

function contractFingerprint(message: AtlasSemanticMessage): string {
  return digestAtlasCanonicalJson('atlas-message-contract/1', {
    resultKind: message.resultKind,
    inputs: message.inputs as unknown as AtlasCanonicalJsonValue,
    slots: message.slots as unknown as AtlasCanonicalJsonValue,
  });
}

function catalogMessageFingerprint(
  snapshot: AtlasCatalogDiffSnapshot,
  identity: string,
  locale: string,
): string | undefined {
  const [providerId, scopeId, messageId, ...remaining] = identity.split(':');
  if (
    providerId === undefined ||
    scopeId === undefined ||
    messageId === undefined ||
    remaining.length > 0
  ) {
    return undefined;
  }
  const message = snapshot.catalogs.find(
    (catalog) =>
      catalog.providerId === providerId &&
      catalog.scopeId === scopeId &&
      catalog.locale === locale,
  )?.messages[messageId];
  if (message === undefined) return undefined;
  return digestAtlasCanonicalJson('atlas-translation-view/1', {
    kind: message.kind,
    source:
      message.kind === 'message' ? message.semantics.canonicalSource : null,
  });
}

function entryKey(entry: AtlasCatalogDiffEntry): string {
  return `${entry.identity}\u0000${entry.previousIdentity ?? ''}\u0000${entry.locale ?? ''}\u0000${entry.kind}`;
}

function addEntry(
  entries: Map<string, AtlasCatalogDiffEntry>,
  entry: AtlasCatalogDiffEntry,
): void {
  entries.set(entryKey(entry), Object.freeze(entry));
}

/**
 * Compares two states of a project and says what a translation team has to do about it.
 *
 * Analyses both snapshots and compares them by message rather than by file, so a message that moved
 * between scopes is one entry rather than two and a reformatted catalog produces none at all.
 *
 * Returns the changes and a digest of them, or the reasons either snapshot could not be analysed.
 * A rename must be declared through `identityMoves`; without that it reads as a deletion and an
 * addition, which throws away the translations.
 */
export function diffAtlasCatalogSets(
  request: AtlasCatalogDiffRequest,
): AtlasResult<AtlasCatalogDiff> {
  const before = analyzeAtlasCatalogSet(request.before);
  const after = analyzeAtlasCatalogSet(request.after);
  const diagnostics = [...before.diagnostics, ...after.diagnostics];
  if (!before.ok || !after.ok) return atlasFailure(diagnostics);

  const beforeMessages = messageMap(before.value);
  const afterMessages = messageMap(after.value);
  const moves = new Map<string, string>();
  const reverseMoves = new Map<string, string>();
  for (const move of request.identityMoves ?? []) {
    if (
      moves.has(move.from) ||
      reverseMoves.has(move.to) ||
      !beforeMessages.has(move.from) ||
      !afterMessages.has(move.to)
    ) {
      return atlasFailure([
        ...diagnostics,
        {
          code: 'ATL1805',
          severity: 'error',
          summary:
            'Semantic catalog diff received an ambiguous or unavailable identity move.',
          path: Object.freeze(['identityMoves']),
        },
      ]);
    }
    moves.set(move.from, move.to);
    reverseMoves.set(move.to, move.from);
  }

  const entries = new Map<string, AtlasCatalogDiffEntry>();
  const identities = new Set([
    ...beforeMessages.keys(),
    ...afterMessages.keys(),
  ]);
  for (const identity of [...identities].sort(compareCodePoint)) {
    if (moves.has(identity) || reverseMoves.has(identity)) continue;
    const prior = beforeMessages.get(identity);
    const current = afterMessages.get(identity);
    if (prior === undefined && current !== undefined) {
      addEntry(entries, {
        kind: 'added',
        identity,
        afterFingerprint: current.sourceFingerprint,
      });
    } else if (prior !== undefined && current === undefined) {
      addEntry(entries, {
        kind: 'removed',
        identity,
        beforeFingerprint: prior.sourceFingerprint,
      });
    }
  }

  const pairs: Array<{
    readonly beforeIdentity: string;
    readonly afterIdentity: string;
    readonly moved: boolean;
  }> = [];
  for (const identity of [...beforeMessages.keys()].sort(compareCodePoint)) {
    const target = moves.get(identity) ?? identity;
    if (afterMessages.has(target)) {
      pairs.push({
        beforeIdentity: identity,
        afterIdentity: target,
        moved: target !== identity,
      });
    }
  }

  for (const pair of pairs) {
    const prior = beforeMessages.get(
      pair.beforeIdentity,
    ) as AtlasSemanticMessage;
    const current = afterMessages.get(
      pair.afterIdentity,
    ) as AtlasSemanticMessage;
    const priorContract = contractFingerprint(prior);
    const currentContract = contractFingerprint(current);
    if (pair.moved || priorContract !== currentContract) {
      addEntry(entries, {
        kind: 'identity-contract-changed',
        identity: pair.afterIdentity,
        ...(pair.moved ? { previousIdentity: pair.beforeIdentity } : {}),
        beforeFingerprint: priorContract,
        afterFingerprint: currentContract,
      });
    }
    const sourceChanged = prior.sourceFingerprint !== current.sourceFingerprint;
    if (sourceChanged) {
      addEntry(entries, {
        kind: 'source-changed',
        identity: pair.afterIdentity,
        ...(pair.moved ? { previousIdentity: pair.beforeIdentity } : {}),
        beforeFingerprint: prior.sourceFingerprint,
        afterFingerprint: current.sourceFingerprint,
      });
    }
    const locales = new Set([
      ...request.before.configuration.locales,
      ...request.after.configuration.locales,
    ]);
    locales.delete(request.before.configuration.sourceLocale);
    locales.delete(request.after.configuration.sourceLocale);
    for (const locale of [...locales].sort(compareCodePoint)) {
      const priorTarget = catalogMessageFingerprint(
        request.before,
        pair.beforeIdentity,
        locale,
      );
      const currentTarget = catalogMessageFingerprint(
        request.after,
        pair.afterIdentity,
        locale,
      );
      if (priorTarget !== currentTarget) {
        addEntry(entries, {
          kind: 'translation-changed',
          identity: pair.afterIdentity,
          ...(pair.moved ? { previousIdentity: pair.beforeIdentity } : {}),
          locale,
          ...(priorTarget === undefined
            ? {}
            : { beforeFingerprint: priorTarget }),
          ...(currentTarget === undefined
            ? {}
            : { afterFingerprint: currentTarget }),
        });
      }
      if (
        sourceChanged &&
        priorTarget !== undefined &&
        priorTarget === currentTarget
      ) {
        addEntry(entries, {
          kind: 'stale-source',
          identity: pair.afterIdentity,
          ...(pair.moved ? { previousIdentity: pair.beforeIdentity } : {}),
          locale,
          beforeFingerprint: priorTarget,
          afterFingerprint: currentTarget,
        });
      }
      if (priorTarget === undefined || currentTarget === undefined) {
        addEntry(entries, {
          kind: 'fallback-impact',
          identity: pair.afterIdentity,
          ...(pair.moved ? { previousIdentity: pair.beforeIdentity } : {}),
          locale,
          ...(priorTarget === undefined
            ? {}
            : { beforeFingerprint: priorTarget }),
          ...(currentTarget === undefined
            ? {}
            : { afterFingerprint: currentTarget }),
        });
      }
    }
  }
  const ordered = [...entries.values()].sort((left, right) =>
    compareCodePoint(entryKey(left), entryKey(right)),
  );
  const digest = digestAtlasCanonicalJson(
    'atlas-semantic-catalog-diff/1',
    ordered as unknown as AtlasCanonicalJsonValue,
  );
  return atlasSuccess(
    Object.freeze({
      profile: 'atlas-semantic-catalog-diff/1',
      entries: Object.freeze(ordered),
      digest,
    }),
    diagnostics,
  );
}
