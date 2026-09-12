import { digestAtlasCanonicalJson } from './canonical-json.js';
import type { AtlasSemanticGraph } from './semantic-model.js';

/**
 * Which source each translation was written against.
 *
 * `specs/04-message-authoring-and-catalogs.spec.md` section 11 derives this from the normalized body
 * and the effective contracts rather than asking an author to maintain a revision field, and makes
 * the default report advisory.
 *
 * Changing the English wording while leaving the old Arabic in place produced success
 * with an empty diagnostics array. Nothing anywhere recorded what a translation corresponded to,
 * so "the source moved and this translation did not" was not a question Atlas could answer.
 *
 * Atlas maintains this record itself. Nothing is asked of a translator and nothing is stamped by
 * hand: each entry carries the source fingerprint at the time of stamping *and* a digest of the
 * translation, and the second value is what removes the human from the loop.
 *
 *   - translation digest moved  -> the translation was updated, re-stamp, not stale
 *   - translation digest same, source fingerprint moved -> stale, and it stays stale until the
 *     translation actually changes
 *
 * A marker a person has to delete would depend on them remembering: forgetting leaves a false
 * flag, and deleting without translating silently clears a real one. Neither failure is visible.
 *
 * The record is committed rather than cached because a fresh checkout and a CI run must reach the
 * same answer as the machine the edit happened on. It cannot live under `.atlas/`, which is
 * declared disposable, nor in the generated root, where deleting and regenerating must preserve
 * everything, and it is the one thing Atlas owns that genuinely cannot be recomputed.
 *
 * Losing the file is not a correctness problem: every entry re-stamps as current and tracking
 * restarts, which reports nothing rather than reporting something false.
 *
 * `specs/10-compiler-and-tooling.spec.md` section 8 is where that ownership is stated: this is
 * the consumer's own durable project data rather than derived output, and it does not belong
 * under a root a project ignores by default.
 */
export const ATLAS_TRANSLATION_STATE_PROFILE =
  'atlas-translation-state/1' as const;

/**
 * Owner-relative location, beside `atlas.config.json` rather than inside `i18n/`.
 *
 * The catalog root holds authored content and refuses entries it does not recognize, which is a
 * property worth keeping rather than widening for a file Atlas writes. Ownership reads correctly
 * this way too: `i18n/` is the translator's, and this is Atlas's.
 */
export const ATLAS_TRANSLATION_STATE_PATH =
  '.atlas-translation-state.json' as const;

export interface AtlasTranslationStateEntry {
  /** Source fingerprint this translation was written against. */
  readonly source: string;
  /** Digest of the translation itself, used to notice that it was updated. */
  readonly target: string;
}

export interface AtlasTranslationState {
  readonly profile: typeof ATLAS_TRANSLATION_STATE_PROFILE;
  readonly entries: Readonly<Record<string, AtlasTranslationStateEntry>>;
}

export interface AtlasStaleTranslation {
  readonly identity: string;
  readonly providerId: string;
  readonly scopeId: string;
  readonly messageId: string;
  readonly locale: string;
}

export interface AtlasTranslationStateReconciliation {
  readonly state: AtlasTranslationState;
  readonly stale: readonly AtlasStaleTranslation[];
  /** True when the reconciled state differs from what was read. */
  readonly changed: boolean;
}

export const EMPTY_ATLAS_TRANSLATION_STATE: AtlasTranslationState =
  Object.freeze({
    profile: ATLAS_TRANSLATION_STATE_PROFILE,
    entries: Object.freeze({}),
  });

function stateKey(identity: string, locale: string): string {
  return `${identity}:${locale}`;
}

function translationDigest(canonicalSource: string | undefined): string {
  // An explicitly empty translation is a deliberate authored value and must be distinguishable
  // from an absent one, so it digests its own sentinel rather than the empty string.
  return digestAtlasCanonicalJson(
    'atlas-translation',
    canonicalSource ?? { empty: true },
  );
}

/**
 * Read a translation state document. Anything unrecognisable is treated as absent rather than as
 * an error: a corrupt or hand-edited record must not stop a build, and re-stamping from scratch
 * reports nothing rather than something false.
 */
export function parseAtlasTranslationState(
  text: string,
): AtlasTranslationState {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return EMPTY_ATLAS_TRANSLATION_STATE;
  }
  if (
    typeof document !== 'object' ||
    document === null ||
    Array.isArray(document)
  ) {
    return EMPTY_ATLAS_TRANSLATION_STATE;
  }
  const record = document as Readonly<Record<string, unknown>>;
  if (record['profile'] !== ATLAS_TRANSLATION_STATE_PROFILE) {
    return EMPTY_ATLAS_TRANSLATION_STATE;
  }
  const rawEntries = record['entries'];
  if (
    typeof rawEntries !== 'object' ||
    rawEntries === null ||
    Array.isArray(rawEntries)
  ) {
    return EMPTY_ATLAS_TRANSLATION_STATE;
  }
  const entries: Record<string, AtlasTranslationStateEntry> = {};
  for (const [key, value] of Object.entries(
    rawEntries as Readonly<Record<string, unknown>>,
  )) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue;
    }
    const entry = value as Readonly<Record<string, unknown>>;
    const source = entry['source'];
    const target = entry['target'];
    if (typeof source !== 'string' || typeof target !== 'string') continue;
    entries[key] = Object.freeze({ source, target });
  }
  return Object.freeze({
    profile: ATLAS_TRANSLATION_STATE_PROFILE,
    entries: Object.freeze(entries),
  });
}

/** Serialise deterministically: sorted keys, stable shape, trailing newline. */
export function formatAtlasTranslationState(
  state: AtlasTranslationState,
): string {
  const keys = Object.keys(state.entries).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const lines = ['{', `  "profile": "${state.profile}",`, '  "entries": {'];
  keys.forEach((key, index) => {
    const entry = state.entries[key];
    if (entry === undefined) return;
    const comma = index === keys.length - 1 ? '' : ',';
    lines.push(
      `    ${JSON.stringify(key)}: { "source": ${JSON.stringify(entry.source)}, "target": ${JSON.stringify(entry.target)} }${comma}`,
    );
  });
  lines.push('  }', '}', '');
  return lines.join('\n');
}

/**
 * Compare the graph against the recorded state.
 *
 * Entries for messages or locales that no longer exist are dropped, so deleting a message does not
 * leave the record growing forever.
 */
export function reconcileAtlasTranslationState(
  graph: AtlasSemanticGraph,
  previous: AtlasTranslationState = EMPTY_ATLAS_TRANSLATION_STATE,
): AtlasTranslationStateReconciliation {
  const entries: Record<string, AtlasTranslationStateEntry> = {};
  const stale: AtlasStaleTranslation[] = [];

  for (const scope of graph.scopes) {
    for (const message of scope.messages) {
      for (const target of message.targets) {
        const key = stateKey(message.identity, target.locale);
        const digest = translationDigest(target.canonicalSource);
        const prior = previous.entries[key];

        if (prior === undefined || prior.target !== digest) {
          // Either the first time this translation has been seen, or it has just been updated.
          // In both cases it now corresponds to the current source.
          entries[key] = Object.freeze({
            source: message.sourceFingerprint,
            target: digest,
          });
          continue;
        }

        // The translation has not moved. If the source has, it no longer describes it, and the
        // record deliberately keeps the older fingerprint so the report persists across runs rather
        // than clearing itself the moment it is noticed.
        entries[key] = prior;
        if (prior.source !== message.sourceFingerprint) {
          stale.push(
            Object.freeze({
              identity: message.identity,
              providerId: message.providerId,
              scopeId: message.scopeId,
              messageId: message.messageId,
              locale: target.locale,
            }),
          );
        }
      }
    }
  }

  const state = Object.freeze({
    profile: ATLAS_TRANSLATION_STATE_PROFILE,
    entries: Object.freeze(entries),
  });

  return Object.freeze({
    state,
    stale: Object.freeze(stale),
    changed:
      formatAtlasTranslationState(state) !==
      formatAtlasTranslationState(previous),
  });
}
