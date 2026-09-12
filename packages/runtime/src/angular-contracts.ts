/**
 * The contracts an application binds when it renders a message itself.
 *
 * `specs/09-safe-content-and-ux.spec.md` section 4 puts styling, components, destinations and
 * handlers in trusted consumer code and leaves a catalog with linguistic placement, so a binding
 * is how an application says what a slot renders. None of it is addressable from a catalog,
 * because a catalog that can name one component can name any component in the application.
 */

import type { Signal, TemplateRef } from '@angular/core';

import type {
  LocaleChangeResult,
  LocaleSelectorChoice,
  LocalizationLifecycle,
  LocalizationParticipantState,
  LocalizationSnapshot,
  LocalizedSlotTemplateContext,
  LocalizedText,
  TrustedDestination,
} from '@neolorn/atlas/core';

/**
 * The contracts whose shape is Angular's, kept out of the core for that reason.
 *
 * These three were in `contracts.ts` and moved here when the Angular-free core became its own entry
 * point. They were not moved because of where they were used, nothing in the core referenced them,
 * but because of what they say: a `Signal` is `@angular/core`'s type, and a contract naming it is
 * a contract about the Angular integration, not about localization.
 *
 * *Why a type-only import mattered.* `import type` is erased, so the core's bundle was already free
 * of Angular and loaded in plain Node: the runtime check passed. The generated `.d.ts` kept the
 * import, which means an Angular-less consumer could run the core and could not typecheck against
 * it. The runtime evidence was real and answered a narrower question than the one being asked. This
 * is why `verify-package-structure.mjs` reads the declarations as well as the JavaScript.
 */

/**
 * Everything a template can read about where localization currently stands, as signals.
 *
 * The read side of `Localization`, named on its own so a component can declare that it only
 * observes. Every member is a signal, so reading one in a template subscribes to it and a locale
 * change refreshes what depends on it and nothing else.
 */
export interface LocalizationState {
  /** Which stage localization is at: starting, ready, changing, or failed. */
  readonly lifecycle: Signal<LocalizationLifecycle>;
  /** Whether there is a committed snapshot to render from. False until the first one lands. */
  readonly ready: Signal<boolean>;
  /**
   * The catalogs currently committed, and `undefined` before the first commit.
   *
   * It changes at the commit rather than during the change, so everything read from it in one
   * rendering pass belongs to the same locale.
   */
  readonly snapshot: Signal<LocalizationSnapshot | undefined>;
  /** The locale being moved to while a change is in flight, and `undefined` when none is. */
  readonly targetLocale: Signal<string | undefined>;
  /**
   * The message to show when localization failed, already localized, or `undefined` when it has
   * not.
   *
   * Carries its own language and direction, because the failure may have happened on the way to a
   * locale the document does not yet claim.
   */
  readonly recovery: Signal<LocalizedText | undefined>;
  /** The retry control's wording, resolved from the recovery payload beside the message. */
  readonly recoveryRetryLabel: Signal<LocalizedText | undefined>;
  /** How the most recent locale change ended, which outlives the change itself. */
  readonly lastResult: Signal<LocaleChangeResult | undefined>;
  /** What each registered participant is doing, for an application that shows its own progress. */
  readonly participants: Signal<readonly LocalizationParticipantState[]>;
  /**
   * The configured locales, as switchable options.
   *
   * The only reason this is here rather than derived by the application: nothing else on this
   * interface names a locale other than the current one, so a consumer had no way to build a
   * switcher without writing its own list of locale literals, which both of this repository's
   * fixtures did, and which is the mutation the template diagnostic now refuses.
   */
  readonly localeChoices: Signal<readonly LocaleSelectorChoice[]>;
}

/**
 * The handle returned when a participant joins locale changes, which is how it is driven and
 * removed.
 *
 * Hold it for as long as the participant should take part. Dropping it without unregistering leaves
 * the participant in every subsequent change.
 */
export interface LocalizationParticipantRegistration {
  /** What this participant is called in diagnostics and in the participant state list. */
  readonly id: string;
  /** What it is currently doing, and how its last turn ended. */
  readonly state: Signal<LocalizationParticipantState>;
  /**
   * Runs this participant again after it failed, without starting a locale change.
   *
   * Resolves to the state it ended in. For a participant whose work is a fetch, this is what a
   * retry button calls.
   */
  retry(): Promise<LocalizationParticipantState>;
  /** Takes the participant out of future changes. Safe to call more than once. */
  unregister(): void;
}

/**
 * What an application says a named slot in a message renders as.
 *
 * A catalog places a slot and names it; what goes in it is decided here, in application code, and
 * is never addressable from the catalog. That is the whole point of the split: a catalog that could
 * name one component could name any component in the application, and a catalog is the file most
 * likely to arrive from outside.
 *
 * Seven kinds: three that carry no data at all (`strong`, `emphasis`, `code`), a link with a
 * destination the application built, an action with a callback and an optional disabled state, a
 * template to project, and a plain string. A slot whose binding is missing, or whose kind does not
 * match what the message asked for, renders nothing rather than falling back to text.
 */
export type TrustedSlotBinding =
  | { readonly kind: 'strong' }
  | { readonly kind: 'emphasis' }
  | { readonly kind: 'code' }
  | {
      readonly kind: 'link';
      readonly destination: TrustedDestination;
    }
  | {
      readonly kind: 'action';
      readonly activate: () => void;
      readonly disabled?: boolean;
    }
  | {
      readonly kind: 'template';
      readonly template: TemplateRef<LocalizedSlotTemplateContext>;
    }
  | {
      readonly kind: 'text';
      readonly projection: string;
    };
