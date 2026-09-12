import { Component, computed, inject } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import {
  LOCALE_URL_POLICY,
  RUNTIME_LIMITS,
  buildLocalizedRoute,
  injectLocalization,
  instant,
  issueMessageId,
  resolveRelativeTime,
  systemClock,
  type LocalizedInputStatus,
  type RelativeTimePolicy,
} from '@neolorn/atlas';
import { LocalizedInput, localizedInputIssueCode } from '@neolorn/atlas/forms';
import { messages } from '#i18n/shell';

import { appFormattingContext } from './app.config';

/**
 * The application-level uses of four exports that had none.
 *
 * These stay on the published surface on the argument that an export sitting beside a
 * documented feature is reachable by a consumer whether or not Atlas's own corpus names it. That
 * argument is only honest if the corpus then names them the way a consumer would, as application
 * code that breaks when they break, not as a test written to reference a symbol. So each use here
 * is one an application would plausibly have written for its own reasons, and each renders
 * something a spec can assert on.
 */

/** Every non-valid input status, so the map below is total by construction. */
const INPUT_ISSUE_STATUSES = Object.freeze([
  'incomplete',
  'invalid',
  'ambiguous',
  'out-of-range',
  'unsupported-capability',
  'policy-rejected',
] as const satisfies readonly Exclude<LocalizedInputStatus, 'valid'>[]);

/**
 * The application's own wording for each input issue, keyed by Atlas's issue code.
 *
 * Built by asking `localizedInputIssueCode` for the code rather than by writing the six code
 * strings out. The point is not brevity: it is that the key and the value the directive puts on
 * the control come from the same function, so they cannot drift. A hand-written `'atlas.input.
 * out-of-range'` that stops matching produces a blank message and no error anywhere.
 */
const INPUT_ISSUE_MESSAGES: ReadonlyMap<string, string> = new Map(
  INPUT_ISSUE_STATUSES.map((status) => [
    localizedInputIssueCode(status),
    status,
  ]),
);

/**
 * Beyond a week, say the date instead of "5 weeks ago".
 *
 * `formatRelativeTime` renders whatever unit it is handed; this is the half that decides whether a
 * relative phrase is the right answer at all, which is a policy an application owns.
 */
const READINESS_RELATIVE_POLICY: RelativeTimePolicy = Object.freeze({
  smallestUnit: 'minute',
  largestUnit: 'day',
});

@Component({
  selector: 'atlas-feature-readiness',
  imports: [ReactiveFormsModule, LocalizedInput],
  template: `
    <section data-readiness>
      <!-- Reciprocal links, built from the one policy copy the injector holds. -->
      <nav data-locale-alternates>
        @for (alternate of alternates(); track alternate.locale) {
          <a [attr.data-alternate]="alternate.locale" [href]="alternate.path">{{
            alternate.locale
          }}</a>
        }
      </nav>

      <p data-readiness-relative>{{ lastChecked() }}</p>
      <p data-readiness-issue-id>{{ backendIssueId() }}</p>
      <p data-readiness-input-issue>{{ inputIssue() }}</p>
      <p data-readiness-catalog-budget>{{ catalogBudgetBytes }}</p>

      <label>
        <span>{{ amountLabel() }}</span>
        <input
          data-readiness-input
          inputmode="decimal"
          [formControl]="amountControl"
          [localizedInput]="{ kind: 'decimal', maximum: boundedMaximum }"
        />
      </label>
    </section>
  `,
})
export class FeatureLabReadiness {
  private readonly localization = injectLocalization();

  /**
   * The policy, read from the injector rather than re-imported from `localization.routes`.
   *
   * `withRouting()` is the only thing that supplies this token, so there is exactly one copy; a
   * second import of the same object would compile and would stop being the same copy the moment
   * the application had two.
   */
  private readonly routing = inject(LOCALE_URL_POLICY);

  /** The clock the application declares. Named here because `app.config.ts` passes it explicitly. */
  private readonly clock = systemClock();

  protected readonly boundedMaximum = Object.freeze({
    kind: 'decimal' as const,
    value: '1000',
  });

  /**
   * The application's own upload cap, expressed against the runtime's ceiling rather than beside it.
   *
   * A number written here would be a second copy of a limit Atlas enforces, and the failure mode is
   * the quiet one: the application offers a bound Atlas refuses, and the refusal names a ceiling the
   * application had no way to read. Publishing `RUNTIME_LIMITS` is what makes this expressible; half
   * the catalog ceiling is a decision this application owns.
   */
  protected readonly catalogBudgetBytes = Math.floor(
    RUNTIME_LIMITS.catalogBytes / 2,
  );

  protected readonly amountControl = new FormControl<unknown>(undefined);

  protected readonly amountLabel = this.localization.textSignal(
    messages.route.item,
  );

  protected readonly alternates = computed(() => {
    const active = this.localization.snapshot()?.primaryLocale;
    const { policy, projection } = this.routing;
    if (active === undefined || policy.kind !== 'path-prefix') return [];
    // Both halves come from the token, so an application that changed its policy or its route table
    // in one place cannot leave this reading the other.
    //
    // And the list is honest about the build without asking: the policy on this token has already
    // been narrowed to the locales the generated configuration lists, so `policy.locales` is what
    // shipped rather than what was declared. Intersecting the two here by hand works and makes
    // this component one of four places that have to remember to. Under
    // `atlas generate --pseudo` this is how a developer reaches the pseudo-locale; under a
    // production build the same code offers only the locales that exist.
    return Object.keys(policy.locales)
      .filter((locale) => locale !== active)
      .map((locale) => ({
        locale,
        path: buildLocalizedRoute(policy, projection, 'route:_index', locale),
      }));
  });

  /**
   * How long since the last readiness check, or the elapsed span when that is too long to phrase.
   *
   * The `absolute` arm is the reason this calls `resolveRelativeTime` rather than
   * `formatRelativeTime`: a span past `largestUnit` comes back as a decision, not as a sentence
   * reading "14 months ago".
   */
  protected readonly lastChecked = computed(() => {
    const now = this.clock.now();
    const elapsedNanoseconds =
      BigInt(now.epochNanoseconds) - 3_600_000_000_000n;
    const outcome = resolveRelativeTime(
      instant(elapsedNanoseconds.toString()),
      now,
      READINESS_RELATIVE_POLICY,
      { ...appFormattingContext, locale: this.localeTag() },
      { numeric: 'auto' },
    );
    if (outcome.kind === 'relative') return outcome.formatted.text;
    if (outcome.kind === 'absolute') {
      return `elapsed:${outcome.elapsedMilliseconds}`;
    }
    return outcome.diagnostic.code;
  });

  /**
   * The message identity a backend failure code names.
   *
   * The application keeps its own wording under `issue.*` and this is what keys it, so a service
   * that changes `INSUFFICIENT_STOCK` to `insufficientStock` does not orphan the translation.
   */
  protected readonly backendIssueId = computed(() =>
    issueMessageId('INSUFFICIENT_STOCK'),
  );

  protected readonly inputIssue = computed(() => {
    const errors = this.amountControl.errors?.['localizedInput'] as
      | { readonly code: string }
      | undefined;
    if (errors === undefined) return 'none';
    return INPUT_ISSUE_MESSAGES.get(errors.code) ?? 'unmapped';
  });

  private localeTag(): string {
    return this.localization.snapshot()?.primaryLocale ?? 'en-US';
  }
}
