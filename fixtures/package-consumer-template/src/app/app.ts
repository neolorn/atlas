import { isPlatformBrowser } from '@angular/common';
import {
  Component,
  PLATFORM_ID,
  TransferState,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { RouterOutlet } from '@angular/router';
import {
  LocaleChoice,
  LocalizedLabel,
  LocalizedMessage,
  LocalizationRecovery,
  LocalizePipe,
  decimal,
  injectLocalization,
  internalDestination,
  percent,
  percentagePoints,
  personName,
  type LocalizedPercentInputProfile,
} from '@neolorn/atlas';
import { LocalizedInput } from '@neolorn/atlas/forms';
import { messages } from '#i18n/shell';
import {
  providerId as lazyProviderId,
  scopeId as lazyScopeId,
} from '#i18n/lazy';

import { BROWSER_FALLBACK_SNAPSHOT, SSR_PROBE_STATE_KEY } from './ssr-probe';
import {
  DynamicContentStore,
  type DynamicPresentationPolicy,
  type FeatureComment,
} from './dynamic-content';
import { FeatureLabReadiness } from './readiness';

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    ReactiveFormsModule,
    LocalizedInput,
    LocalizedMessage,
    LocalizationRecovery,
    LocalizePipe,
    LocalizedLabel,
    LocaleChoice,
    FeatureLabReadiness,
  ],
  template: `
    <main>
      <!--
        A row of individually identifiable cells, wide enough that the page genuinely overflows
        along the inline axis.

        The scroll restore across a locale commit could not be checked without it. The rest of this
        page is a single column, so every element under the viewport's inline-start edge spans the
        whole width, and the element found there is the same one whether the restore returns the
        visitor to where they were or to the mirror-image position. The gate ran green against both
        designs, which is what a fixture too small to tell two answers apart does.

        120px cells over a 420px viewport make the two land twelve cells apart. First inside <main>
        and tall enough to cover the probed point, so it is in view at the block offset the check
        scrolls to.
      -->
      <section data-inline-scroll-strip>
        @for (cell of inlineScrollCells; track cell) {
          <span [attr.data-inline-cell]="cell">{{ cell }}</span>
        }
      </section>
      <localization-recovery [retryLabel]="retryLabel()" />
      <h1>{{ title() }}</h1>
      <p data-welcome>{{ welcome() }}</p>
      <p
        data-source-fallback
        [attr.lang]="sourceFallback().language"
        [attr.dir]="sourceFallback().direction"
        [attr.data-supplying-locale]="sourceFallback().supplyingLocale"
      >
        {{ sourceFallback().value }}
      </p>
      <p data-inert-text>{{ inertText() }}</p>
      <p data-pipe>{{ messages.appTitle | localize }}</p>
      <!-- An attribute is where the ordinary ways of putting a message in a template run out. -->
      <div data-label [localizedLabel]="messages.appTitle"></div>
      <img
        data-label-alt
        alt="static alt"
        src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="
        [localizedLabel]="messages.asset.alt"
        localizedLabelAttribute="title"
      />
      <localized-message data-rich-message [handle]="messages.learnMore" />
      <localized-message
        data-rich-link
        [handle]="messages.helpLink"
        [slots]="helpBindings"
      />
      <localized-message
        data-rich-action
        [handle]="messages.continueAction"
        [slots]="actionBindings"
      />
      <span data-action-count>{{ actionCount() }}</span>
      <p data-percent>{{ formattedPercent() }}</p>
      <p data-percentage-points>{{ formattedPercentagePoints() }}</p>
      <p data-list>{{ formattedList() }}</p>
      <p data-relative-time>{{ formattedRelativeTime() }}</p>
      <p
        data-person-name
        [attr.lang]="personPresentation().language"
        [attr.dir]="personPresentation().direction"
      >
        {{ personPresentation().text }}
      </p>
      <form data-localized-form (submit)="submitForm($event)">
        <label>
          {{ localizedPercentLabel() }}
          <input
            data-percent-input
            inputmode="decimal"
            [formControl]="percentControl"
            [localizedInput]="percentProfile"
          />
        </label>
        <button data-submit type="submit">{{ submitLabel() }}</button>
      </form>
      <p data-percent-model>{{ percentControl.value.amount.value }}</p>
      <p data-submitted>{{ submitted() }}</p>
      <p data-locale>{{ locale() }}</p>
      <atlas-feature-readiness />
      <section
        data-dynamic-content
        [attr.data-presentation]="dynamicPresentation().kind"
        [attr.data-participant-status]="dynamicParticipantStatus()"
        [attr.data-source-requests]="dynamicStore.source.requestCount"
      >
        <p data-dynamic-status>{{ dynamicParticipantStatus() }}</p>
        @if (dynamicPresentation().article; as article) {
          <article
            data-dynamic-article
            [attr.lang]="article.supplyingLocale"
            [attr.dir]="article.direction"
            [attr.data-payload-marker]="article.payloadMarker"
          >
            <h2 data-dynamic-title>{{ article.title }}</h2>
            <p data-dynamic-summary>{{ article.summary }}</p>
            <p data-dynamic-source>{{ article.sourceLabel }}</p>
            <ul data-dynamic-comments>
              @for (comment of article.comments; track comment.id) {
                <li
                  [attr.data-comment-id]="comment.id"
                  [attr.data-representation]="comment.representation.kind"
                  [attr.lang]="commentLanguage(comment)"
                  [attr.dir]="commentDirection(comment)"
                >
                  {{ comment.text }}
                </li>
              }
            </ul>
          </article>
        } @else {
          <p data-dynamic-placeholder>{{ dynamicPresentation().kind }}</p>
        }
        <button
          type="button"
          data-policy-retain
          (click)="setDynamicPolicy('retain')"
        >
          {{ retainLabel() }}
        </button>
        <button
          type="button"
          data-policy-skeleton
          (click)="setDynamicPolicy('skeleton')"
        >
          {{ skeletonLabel() }}
        </button>
        <button
          type="button"
          data-policy-hide
          (click)="setDynamicPolicy('hide')"
        >
          {{ hideLabel() }}
        </button>
        <button
          type="button"
          data-policy-substitute
          (click)="setDynamicPolicy('substitute')"
        >
          {{ substituteLabel() }}
        </button>
        <button
          type="button"
          data-dynamic-retry
          (click)="retryDynamicContent()"
        >
          {{ dynamicRetryLabel() }}
        </button>
      </section>
      <!--
        The switcher, with no locale in it.

        This was two buttons carrying 'en-US' and 'ar-EG' as literals, a hand-written lang and dir
        per button, and a hand-written label in a language the author of the second one could not
        read. Adding a third locale meant a third button and six more attributes to get right, and
        nothing would have failed if one of them was wrong.

        The loop is the application's, because it is the application's layout. Everything inside the
        option is the runtime's: localeChoice writes lang, dir, aria-current and aria-busy
        from the choice, writes the address this page has in that locale as href, and switches on
        activation. Anchors rather than buttons because there is an address: this control leads
        somewhere, and a reader who opens it in a new tab gets the page they asked for.
      -->
      @for (choice of localeChoices(); track choice.locale) {
        <a [attr.data-locale-choice]="choice.locale" [localeChoice]="choice">
          {{ choice.selfName }}
        </a>
      }
      <button data-lazy-load type="button" (click)="loadLazyScope()">
        {{ loadScopeLabel() }}
      </button>
      @if (progressiveTarget(); as target) {
        <!--
          The same rule as the switcher above: the locale this demonstrates progressive mode
          against is the one that is not current, which the choices already say. Written as the
          string 'ar-EG', a third configured locale would leave it demonstrating nothing.
        -->
        <button
          data-locale-ar-progressive
          type="button"
          (click)="selectLocaleProgressive(target.locale)"
        >
          {{ progressiveLocaleLabel() }}
        </button>
      }
      <p data-lazy-readiness>{{ lazyReadiness().status }}</p>
      <p data-lazy-message>{{ lazyText() }}</p>
      <section
        data-ssr-probe
        [attr.data-request-id]="probeSnapshot.requestId"
        [attr.data-label]="probeSnapshot.label"
        [attr.data-source]="probeSnapshot.source"
        [attr.data-snapshot-locale]="probeSnapshot.locale"
      >
        <span data-probe-label>{{ probeSnapshot.label }}</span>
      </section>
      <button data-counter type="button" (click)="increment()">
        {{ counterLabel() }} {{ counter() }}
      </button>
      @defer (hydrate on interaction) {
        <!--
          The locale can commit while this block is still inert server HTML, and hydration claims
          that HTML rather than writing it. What keeps the block honest is not a directive but the
          ordinary update pass: the browser gate switches the locale first, then triggers hydration,
          and asserts both that the text arrives in Arabic and that the click which triggered it
          still lands. Measured across eight binding kinds; every one is corrected on
          the claim.
        -->
        <section data-incremental-boundary>
          <p data-incremental-message>{{ incrementalText() }}</p>
          <button
            data-incremental-action
            type="button"
            (click)="activateIncremental()"
          >
            {{ incrementalActionLabel() }}
          </button>
          <span data-incremental-count>{{ incrementalCount() }}</span>
        </section>
      }
      <router-outlet />
    </main>
  `,
  styles: `
    [data-inline-scroll-strip] {
      display: flex;
      width: max-content;
      height: 900px;
    }
    [data-inline-scroll-strip] > span {
      flex: none;
      width: 120px;
      font: 24px monospace;
    }
    [data-inline-scroll-strip] > span:nth-child(odd) {
      background: color-mix(in srgb, currentColor 8%, transparent);
    }
  `,
})
export class App {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly transferState = inject(TransferState);
  private readonly localization = injectLocalization();
  protected readonly dynamicStore = inject(DynamicContentStore);

  // Twenty of them: 2400px against the 420px viewport the browser gate pins, so the offset it
  // scrolls to is mid-page rather than clamped, and the correct and incorrect restores land on
  // different cells rather than on the same wide element.
  protected readonly inlineScrollCells = Array.from(
    { length: 20 },
    (_unused, index) => index,
  );

  protected readonly title = this.localization.textSignal(messages.appTitle);
  protected readonly messages = messages;
  protected readonly welcome = this.localization.textSignal(messages.welcome, {
    name: 'Atlas',
  });
  protected readonly sourceFallback = computed(() =>
    this.localization.evaluateText(messages.sourceOnly),
  );
  protected readonly inertText = this.localization.textSignal(
    messages.unsafeLiteral,
  );
  protected readonly locale = computed(
    () => this.localization.snapshot()?.primaryLocale ?? 'uninitialized',
  );
  protected readonly targetLocale = this.localization.targetLocale;
  protected readonly localeChoices = this.localization.localeChoices;
  /** The locale a switch would move to, which is the one that is not current. */
  protected readonly progressiveTarget = computed(() =>
    this.localeChoices().find((choice) => !choice.current),
  );
  protected readonly dynamicPresentation = this.dynamicStore.presentation;
  protected readonly dynamicParticipantStatus = computed(
    () => this.dynamicStore.participantState()?.attempt.status ?? 'idle',
  );
  protected readonly formattedPercent = computed(() => {
    const result = this.localization.formatPercent(percent(decimal('0.25')));
    return result.ok ? result.value.text : result.diagnostic.code;
  });
  protected readonly formattedPercentagePoints = computed(() => {
    const result = this.localization.formatPercentagePoints(
      percentagePoints(decimal('5')),
    );
    return result.ok ? result.value.text : result.diagnostic.code;
  });
  protected readonly formattedList = computed(() => {
    const result = this.localization.formatList(['Atlas', 'Angular', 'Intl']);
    return result.ok ? result.value.text : result.diagnostic.code;
  });
  protected readonly formattedRelativeTime = computed(() => {
    const result = this.localization.formatRelativeTime(decimal('-1'), 'day', {
      numeric: 'auto',
    });
    return result.ok ? result.value.text : result.diagnostic.code;
  });
  protected readonly personPresentation = computed(() => {
    const result = this.localization.formatPersonName(
      personName('ar', { given: 'هشام', surname: 'محمد' }),
      { order: 'given-first' },
    );
    return result.ok
      ? result.value
      : {
          text: result.diagnostic.code,
          language: 'ar',
          direction: 'rtl' as const,
        };
  });
  protected readonly retryLabel = this.localization.textSignal(
    messages.control.retry,
  );
  protected readonly submitLabel = this.localization.textSignal(
    messages.control.submit,
  );
  protected readonly counterLabel = this.localization.textSignal(
    messages.counter.label,
  );
  protected readonly hideLabel = this.localization.textSignal(
    messages.dynamic.hide,
  );
  protected readonly retainLabel = this.localization.textSignal(
    messages.dynamic.retain,
  );
  protected readonly dynamicRetryLabel = this.localization.textSignal(
    messages.dynamic.retry,
  );
  protected readonly skeletonLabel = this.localization.textSignal(
    messages.dynamic.skeleton,
  );
  protected readonly substituteLabel = this.localization.textSignal(
    messages.dynamic.substitute,
  );
  protected readonly localizedPercentLabel = this.localization.textSignal(
    messages.form.percentLabel,
  );
  protected readonly progressiveLocaleLabel = this.localization.textSignal(
    messages.locale.progressive,
  );
  protected readonly loadScopeLabel = this.localization.textSignal(
    messages.scope.load,
  );
  protected readonly percentProfile: LocalizedPercentInputProfile =
    Object.freeze({
      kind: 'percent',
      scale: 'fractional',
      requirePercentSign: true,
      maximumFractionDigits: 2,
    });
  protected readonly percentControl = new FormControl(
    percent(decimal('0.25')),
    { nonNullable: true },
  );
  protected readonly probeSnapshot = this.transferState.get(
    SSR_PROBE_STATE_KEY,
    BROWSER_FALLBACK_SNAPSHOT,
  );
  protected readonly counter = signal(0);
  protected readonly incrementalCount = signal(0);
  protected readonly incrementalText = this.localization.textSignal(
    messages.incremental.ready,
  );
  protected readonly incrementalActionLabel = this.localization.textSignal(
    messages.incremental.action,
  );
  protected readonly submitted = signal(false);
  protected readonly actionCount = signal(0);
  protected readonly helpBindings = Object.freeze({
    link: Object.freeze({
      kind: 'link' as const,
      destination: internalDestination('/help'),
    }),
  });
  protected readonly actionBindings = Object.freeze({
    action: Object.freeze({
      kind: 'action' as const,
      activate: () => this.actionCount.update((value) => value + 1),
    }),
  });
  private readonly lazyScopeLoaded = signal(false);
  // The scope's own messages render in the route behind the lazy boundary: naming one here
  // would put it in the first render's bundle and make the scope a startup scope.
  protected readonly lazyText = computed(() =>
    this.lazyScopeLoaded()
      ? this.lazyReadiness().status
      : this.localization.text(messages.scope.notLoaded),
  );
  protected readonly lazyReadiness = this.localization.scopeReadiness({
    providerId: lazyProviderId,
    scopeId: lazyScopeId,
  });

  constructor() {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    const adoptedSource = this.probeSnapshot.source;
    this.transferState.remove(SSR_PROBE_STATE_KEY);

    afterNextRender(() => {
      document.documentElement.dataset['clientReady'] = 'true';
      document.documentElement.dataset['transferSource'] = adoptedSource;
    });
  }

  protected increment(): void {
    this.counter.update((value) => value + 1);
  }

  protected setDynamicPolicy(policy: DynamicPresentationPolicy): void {
    this.dynamicStore.setPresentationPolicy(policy);
  }

  protected retryDynamicContent(): void {
    void this.dynamicStore.retry();
  }

  protected commentLanguage(comment: FeatureComment): string | null {
    switch (comment.representation.kind) {
      case 'locale-bound':
        return comment.representation.supplyingLocale;
      case 'user-authored':
      case 'fixed-language':
        return comment.representation.language ?? null;
      default:
        return null;
    }
  }

  protected commentDirection(comment: FeatureComment): 'ltr' | 'rtl' | 'auto' {
    return 'direction' in comment.representation &&
      comment.representation.direction !== undefined
      ? comment.representation.direction
      : 'auto';
  }

  protected activateIncremental(): void {
    this.incrementalCount.update((value) => value + 1);
  }

  protected submitForm(event: SubmitEvent): void {
    event.preventDefault();
    this.submitted.set(true);
  }

  /**
   * One call, and no route knowledge in it.
   *
   * `RouteLocalization.navigate(locale)` builds the *localized* URL and hands it to the Router,
   * and the Router's addresses are canonical, so a localized one is an unmatched path.
   * `changeLocale` commits the locale and Atlas's address sync moves the address bar, which is why
   * a component switching locale needs to know nothing about the application having routes.
   */
  protected selectLocaleProgressive(locale: string): void {
    void this.localization.changeLocale(locale, {
      mode: 'progressive',
      progressiveScopes: [{ providerId: lazyProviderId, scopeId: lazyScopeId }],
    });
  }

  protected async loadLazyScope(): Promise<void> {
    await this.localization.ensureScope({
      providerId: lazyProviderId,
      scopeId: lazyScopeId,
    });
    this.lazyScopeLoaded.set(true);
  }
}
