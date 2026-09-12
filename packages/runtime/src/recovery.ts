/**
 * What renders when the localization runtime could not reach a usable state.
 *
 * `specs/03-locale-identity-and-resolution.spec.md` section 11 requires the payload to be derived
 * from the messages a consumer already writes, and requires this renderer to be reachable by
 * assistive technology, to carry the language and direction of what it renders, and to offer a
 * retry. It renders when catalog loading has already failed, so neither its text nor its
 * announcement can come from a catalog.
 *
 * The retry control's wording comes from that payload too. It was a plain string, which put an
 * English button inside a region already marked `lang="ar"`, where a screen reader reads English
 * words under Arabic pronunciation rules. The payload is keyed by identity and locale and has
 * always held whatever the compiler was told to put in it, so carrying a second message is the
 * same lookup rather than a second mechanism.
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import {
  type LocaleDirection,
  type LocalizationDiagnostic,
  type LocalizationSnapshot,
} from '@neolorn/atlas/core';
import { Localization } from './localization';

/**
 * What the template needs to draw the control, from either source.
 *
 * `language` and `direction` are nullable because they are a claim, and Atlas can only make one
 * about a message it resolved. A string an application typed here has no locale Atlas knows, so
 * nothing is written and the control inherits the region's own.
 */
interface RetryControl {
  readonly value: string;
  readonly language: string | null;
  readonly direction: LocaleDirection | null;
}

/**
 * The region that says localization failed, in a language the reader can read.
 *
 * Drop `<localization-recovery />` somewhere persistent, usually the application shell. It draws
 * nothing at all while localization is healthy, and on a failure it renders an assertive alert
 * carrying the message and, where one is available, a button that retries.
 *
 * The message and the button's wording are marked with their own language and direction rather than
 * inheriting the page's, because a failure that happened while moving between locales is a failure
 * whose text may not be in the language the document currently claims.
 */
@Component({
  selector: 'localization-recovery',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (localization.recovery(); as recovery) {
      <section
        role="alert"
        aria-live="assertive"
        [attr.lang]="recovery.language"
        [attr.dir]="recovery.direction"
      >
        <p>{{ recovery.value }}</p>
        @if (retryControl(); as control) {
          <button
            type="button"
            [disabled]="retrying()"
            [attr.lang]="control.language"
            [attr.dir]="control.direction"
            (click)="retry()"
          >
            {{ control.value }}
          </button>
        }
      </section>
    }
  `,
})
export class LocalizationRecovery {
  protected readonly localization = inject(Localization);
  /**
   * The retry control's wording, for a caller with no handle to give.
   *
   * An override rather than the source. Pass a handle to `withRecoveryMessage` and the wording
   * arrives from the payload in the locale this region is already marked as.
   */
  readonly retryLabel = input<string>();
  /**
   * Emits the snapshot that was committed when a retry succeeded, for an application with something
   * to do once the text is back.
   */
  readonly recovered = output<LocalizationSnapshot>();
  /** Emits why a retry did not work. The region stays up and the button becomes usable again. */
  readonly retryFailed = output<LocalizationDiagnostic>();
  protected readonly retrying = signal(false);

  /**
   * Either source makes the control appear, and the localized one wins.
   *
   * An application that passed a string before this existed keeps the button it had, and one that
   * selects a retry label gets a localized button without editing its template.
   */
  protected readonly retryControl = computed<RetryControl | undefined>(() => {
    const localized = this.localization.recoveryRetryLabel();
    if (localized !== undefined) {
      return {
        value: localized.value,
        language: localized.language,
        direction: localized.direction,
      };
    }
    const supplied = this.retryLabel();
    return supplied === undefined
      ? undefined
      : { value: supplied, language: null, direction: null };
  });

  protected retry(): void {
    if (this.retrying()) return;
    this.retrying.set(true);
    void this.localization.retry().then(
      (snapshot) => {
        this.retrying.set(false);
        this.recovered.emit(snapshot);
      },
      (error: unknown) => {
        this.retrying.set(false);
        if (
          typeof error === 'object' &&
          error !== null &&
          'diagnostic' in error
        ) {
          this.retryFailed.emit(
            (error as { readonly diagnostic: LocalizationDiagnostic })
              .diagnostic,
          );
        }
      },
    );
  }
}
