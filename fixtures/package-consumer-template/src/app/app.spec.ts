import { parseAtlasConfiguration } from '@neolorn/atlas-toolkit';

import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NgControl } from '@angular/forms';
import { provideRouter } from '@angular/router';
import { Component } from '@angular/core';
import {
  LABEL_ATTRIBUTES,
  Localization,
  LocalizedLabel,
  decimal,
  fixedClock,
  instant,
  presentExternalValue,
  presentIssue,
  presentNotification,
  percent,
  percentagePoints,
  withLocaleAnnouncement,
  withRouting,
  withOverlayLocale,
  withRecoveryMessage,
} from '@neolorn/atlas';
import {
  LocalizationTestingController,
  provideLocalizationTesting,
} from '@neolorn/atlas/testing';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';
import { routeProjection } from '#i18n/routes';
import { messages, providerId, scopeId } from '#i18n/shell';
import {
  messages as lazyMessages,
  providerId as lazyProviderId,
  scopeId as lazyScopeId,
} from '#i18n/lazy';

import { App } from './app';
import { atlasRuntimeExtensions } from './runtime-extensions';
import { provideDynamicContent } from './dynamic-content';
import { routePolicy, appRouteProjection } from './localization.routes';

/**
 * An attribute the directive is built not to touch, reached the only way it can be: by casting
 * past the template's type checking.
 */
@Component({
  selector: 'atlas-refused-label',
  imports: [LocalizedLabel],
  template: `
    <a
      data-refused
      href="/safe"
      [localizedLabel]="handle"
      [localizedLabelAttribute]="attribute"
    ></a>
  `,
})
class RefusedLabel {
  protected readonly handle = messages.appTitle;
  protected readonly attribute = 'href' as never;
}

const lazyScope = {
  providerId: lazyProviderId,
  scopeId: lazyScopeId,
} as const;

describe('Atlas feature-lab package consumer', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([]),
        provideLocalizationTesting(
          {
            configuration,
            catalogSet,
            catalogLoaders,
            recoveryPayload,
            extensions: atlasRuntimeExtensions,
            maximumCachedCatalogs: 1,
            routeProjection,
          },
          withRecoveryMessage({
            message: messages.recovery.unavailable,
            retryLabel: messages.control.retry,
          }),
          withLocaleAnnouncement(
            (snapshot) => `locale:${snapshot.primaryLocale}`,
          ),
          // The application declares this in `app.config.ts` and this setup did not, so the shell
          // under test was a shell the application never runs. It went unnoticed while nothing in
          // the shell read the policy; the readiness panel does, and `LOCALE_URL_POLICY` has
          // exactly one supplier.
          withRouting({
            policy: routePolicy,
            projection: appRouteProjection,
          }),
        ),
        provideDynamicContent(),
      ],
    }).compileComponents();
    await TestBed.inject(Localization).initialize();
  });

  it('resolves the built runtime, testing entry point, and generated imports', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();

    const element = fixture.nativeElement as HTMLElement;
    expect(messages.appTitle.identity).toContain(':shell:app-title');
    const localization = TestBed.inject(Localization);
    expect(localization.textSignal(messages.appTitle)).toBe(
      localization.textSignal(messages.appTitle),
    );
    expect(element.querySelector('h1')?.textContent).toContain(
      'Atlas feature lab',
    );
    expect(element.querySelector('[data-welcome]')?.textContent).toContain(
      'Welcome, Atlas!',
    );
    expect(element.querySelector('[data-rich-message]')?.textContent).toContain(
      'Read the guide.',
    );
    expect(
      element.querySelector('[data-rich-message] strong')?.textContent,
    ).toContain('guide');
    expect(
      element.querySelector('[data-rich-link] a')?.getAttribute('href'),
    ).toBe('/help');
    expect(
      element.querySelector('[data-rich-action] button')?.getAttribute('type'),
    ).toBe('button');
    (
      element.querySelector('[data-rich-action] button') as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    expect(element.querySelector('[data-action-count]')?.textContent).toContain(
      '1',
    );
    expect(element.querySelector('[data-percent]')?.textContent).toContain(
      '25%',
    );
    expect(
      element.querySelector('[data-percentage-points]')?.textContent,
    ).toContain('5');
    expect(element.querySelector('[data-inert-text] img')).toBeNull();
    expect(element.querySelector('[data-inert-text]')?.textContent).toContain(
      '<img src=x onerror=alert(1)>',
    );
    expect(element.querySelector('[data-locale]')?.textContent).toContain(
      configuration.defaultLocale,
    );
    // Nothing in the template says any of this. The subtag, the direction and the endonym are the
    // runtime's, and the option carries them because the directive put them there.
    expect(element.querySelector('[data-locale-choice="en-US"]')).toMatchObject(
      {
        lang: 'en',
        dir: 'ltr',
      },
    );
    expect(
      element
        .querySelector('[data-locale-choice="en-US"]')
        ?.getAttribute('aria-current'),
    ).toBe('true');
    expect(
      element
        .querySelector('[data-locale-choice="en-US"]')
        ?.textContent?.trim(),
    ).toBe('American English');
    expect(element.querySelector('[data-locale-choice="ar-EG"]')).toMatchObject(
      {
        lang: 'ar',
        dir: 'rtl',
      },
    );
    expect(
      element
        .querySelector('[data-locale-choice="ar-EG"]')
        ?.textContent?.trim(),
    ).toBe('العربية (مصر)');
    expect(
      element
        .querySelector('[data-locale-choice="ar-EG"]')
        ?.hasAttribute('aria-current'),
    ).toBe(false);
  });

  it('reacts zonelessly to a coherent local-catalog locale commit', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    await TestBed.inject(Localization).changeLocale('ar-EG');
    await fixture.whenStable();
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('h1')?.textContent).toContain(
      'مختبر ميزات Atlas',
    );
    expect(element.querySelector('[data-welcome]')?.textContent).toContain(
      'مرحبًا، \u2067Atlas\u2069!',
    );
    expect(element.querySelector('[data-pipe]')?.textContent).toContain(
      'مختبر ميزات Atlas',
    );
    // An attribute-position label follows the active locale like anything else, and writing one
    // attribute leaves the element's other attributes alone: a host binding on every supported
    // name would have cleared this img's static alt.
    expect(
      element.querySelector('[data-label]')?.getAttribute('aria-label'),
    ).toBe('مختبر ميزات Atlas');
    const labelled = element.querySelector('[data-label-alt]');
    expect(labelled?.getAttribute('title')).toBe('غلاف دليل Atlas');
    expect(labelled?.getAttribute('alt')).toBe('static alt');
    expect(labelled?.hasAttribute('aria-label')).toBe(false);
    expect(element.querySelector('[data-rich-message]')?.textContent).toContain(
      'اقرأ الدليل.',
    );
    expect(
      element.querySelector('[data-rich-link] a')?.getAttribute('href'),
    ).toBe('/help');
    expect(document.documentElement.lang).toBe('ar-EG');
    expect(document.documentElement.dir).toBe('rtl');
    expect(
      element
        .querySelector('[data-locale-choice="ar-EG"]')
        ?.getAttribute('aria-current'),
    ).toBe('true');

    const fallback = TestBed.inject(Localization).evaluateText(
      messages.sourceOnly,
    );
    expect(fallback.value).toBe('Source fallback remains truthful.');
    expect(fallback.targetLocale).toBe('ar-EG');
    expect(fallback.supplyingLocale).toBe('en-US');
    expect(fallback.fallback).toBe(true);
  });

  it('keeps the committed view while the latest locale intent supersedes pending work', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const localization = TestBed.inject(Localization);
    const controller = TestBed.inject(LocalizationTestingController);
    const delayed = controller.deferNext({ providerId, scopeId }, 'ar-EG');

    const slow = localization.changeLocale('ar-EG');
    await delayed.started;

    expect(localization.lifecycle()).toBe('transitioning');
    expect(localization.targetLocale()).toBe('ar-EG');
    // The switch is in flight, and the choice for the locale it is moving to says so. There is no
    // separate status to read: the lifecycle above is the state of the transaction, and `pending`
    // is the state of this option, which is what a control renders.
    const choices = localization.localeChoices();
    const arriving = choices.find(({ locale }) => locale === 'ar-EG');
    expect(arriving).toMatchObject({
      pending: true,
      current: false,
      language: 'ar',
      direction: 'rtl',
    });
    // The label is the build's, not the engine's. Compared against the generated configuration
    // rather than against a literal: what is being asserted is where the string comes from, and a
    // literal would pass just as well if the runtime went back to asking `Intl.DisplayNames`.
    // Node agrees with CLDR about this locale, which is exactly why the literal proves nothing.
    expect(configuration.localeNames?.['ar-EG']).toBeTypeOf('string');
    expect(arriving?.selfName).toBe(configuration.localeNames?.['ar-EG']);
    expect(localization.snapshot()?.primaryLocale).toBe('en-US');
    expect(fixture.nativeElement.querySelector('h1')?.textContent).toContain(
      'Atlas feature lab',
    );

    const latest = localization.changeLocale('en-US');
    await expect(slow).resolves.toMatchObject({ status: 'superseded' });
    await expect(latest).resolves.toMatchObject({
      status: 'committed',
      targetLocale: 'en-US',
    });
    delayed.release();
    await Promise.resolve();

    expect(localization.snapshot()?.primaryLocale).toBe('en-US');
    expect(localization.targetLocale()).toBeUndefined();
  });

  it('deduplicates equivalent work and evicts unpinned catalogs within the configured bound', async () => {
    const localization = TestBed.inject(Localization);
    const controller = TestBed.inject(LocalizationTestingController);
    const delayed = controller.deferNext({ providerId, scopeId }, 'ar-EG');

    const first = localization.changeLocale('ar-EG');
    const equivalent = localization.changeLocale('ar-EG');
    expect(equivalent).toBe(first);
    await delayed.started;
    delayed.release();
    await expect(first).resolves.toMatchObject({ status: 'committed' });
    expect(controller.loadCount({ providerId, scopeId }, 'ar-EG')).toBe(1);

    await localization.changeLocale('en-US');
    await localization.changeLocale('ar-EG');
    expect(controller.loadCount({ providerId, scopeId }, 'ar-EG')).toBe(2);
  });

  it('keeps canonical values exact and percentage scales explicit', () => {
    const localization = TestBed.inject(Localization);
    expect(decimal('0001.2300').value).toBe('1.23');
    expect(fixedClock(instant('1000000')).now().epochNanoseconds).toBe(
      '1000000',
    );

    const fractional = localization.formatPercent(percent(decimal('0.25')));
    const percentUnit = localization.formatPercent(
      percent(decimal('25'), 'percent-unit'),
    );
    const points = localization.formatPercentagePoints(
      percentagePoints(decimal('5')),
    );
    const unsafePrecision = localization.formatNumber(
      decimal('9007199254740993'),
    );
    const deterministicInstant = localization.formatInstant(instant('0'), {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: 'UTC',
    });
    const ambientInstant = localization.formatInstant(instant('0'), {
      year: 'numeric',
    });

    expect(fractional.ok && fractional.value.text).toBe('25%');
    expect(percentUnit.ok && percentUnit.value.text).toBe('25%');
    expect(
      points.ok &&
        points.value.parts.some(
          ({ kind, value }) =>
            kind === 'semantic-unit' && value === 'percentage-points',
        ),
    ).toBe(true);
    expect(unsafePrecision).toMatchObject({
      ok: false,
      diagnostic: { code: 'unsupported-formatting-capability' },
    });
    expect(deterministicInstant).toMatchObject({ ok: true });
    expect(ambientInstant).toMatchObject({
      ok: false,
      diagnostic: { code: 'unsupported-formatting-capability' },
    });
  });

  it('keeps localized Forms models invariant while preserving validation, focus, selection, and composition', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const input = element.querySelector(
      '[data-percent-input]',
    ) as HTMLInputElement;
    const control = fixture.debugElement
      .query(By.css('[data-percent-input]'))
      .injector.get(NgControl).control;

    expect(input.value).toContain('25');
    expect(
      element.querySelector('[data-percent-model]')?.textContent,
    ).toContain('0.25');
    input.focus();
    input.setSelectionRange(1, 2);
    input.value = '50%';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(
      element.querySelector('[data-percent-model]')?.textContent,
    ).toContain('0.5');
    expect(control?.dirty).toBe(true);

    input.dispatchEvent(new Event('blur'));
    expect(control?.touched).toBe(true);
    element
      .querySelector('[data-localized-form]')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(element.querySelector('[data-submitted]')?.textContent).toContain(
      'true',
    );
    input.value = '1 2%';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(control?.errors).toEqual({
      localizedInput: {
        code: 'atlas.input.invalid',
        status: 'invalid',
      },
    });
    expect(
      element.querySelector('[data-percent-model]')?.textContent,
    ).toContain('0.5');
    expect(element.querySelector('[data-submitted]')?.textContent).toContain(
      'true',
    );

    await TestBed.inject(Localization).changeLocale('ar-EG');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(input.value).toBe('1 2%');
    expect(control?.errors).toEqual({
      localizedInput: {
        code: 'atlas.input.invalid',
        status: 'invalid',
      },
    });
    expect(
      element.querySelector('[data-percent-model]')?.textContent,
    ).toContain('0.5');
    expect(element.querySelector('[data-submitted]')?.textContent).toContain(
      'true',
    );
    await TestBed.inject(Localization).changeLocale('en-US');
    await fixture.whenStable();
    fixture.detectChanges();

    input.value = '50%';
    input.dispatchEvent(new Event('input'));
    input.focus();
    input.setSelectionRange(1, 2);
    await TestBed.inject(Localization).changeLocale('ar-EG');
    await fixture.whenStable();
    fixture.detectChanges();
    await Promise.resolve();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).not.toBeNull();
    expect(
      element.querySelector('[data-percent-model]')?.textContent,
    ).toContain('0.5');
    // Atlas owns this region and puts it on the document, so it is found there rather than inside
    // the component under test, which is the point: nothing in the application renders it.
    expect(
      document.querySelector('[data-atlas-announcer]')?.textContent,
    ).toContain('locale:ar-EG');

    input.value = 'composition in progress';
    input.dispatchEvent(new Event('compositionstart'));
    input.dispatchEvent(new Event('input'));
    await TestBed.inject(Localization).changeLocale('en-US');
    fixture.detectChanges();
    expect(input.value).toBe('composition in progress');
    input.dispatchEvent(new Event('compositionend'));
    expect(
      element.querySelector('[data-percent-model]')?.textContent,
    ).toContain('0.5');
  });

  it('refuses to write a localized label into an attribute that is not text', () => {
    // `href`, `src` and every `on*` attribute are where a string stops being text and becomes a
    // navigation or a program. The list is closed so that routing translated content into one of
    // them cannot be a one-word template change.
    for (const attribute of ['href', 'src', 'formaction', 'onclick']) {
      expect(LABEL_ATTRIBUTES).not.toContain(attribute);
    }

    const fixture = TestBed.createComponent(RefusedLabel);
    fixture.detectChanges();
    const anchor = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-refused]',
    );

    expect(anchor?.getAttribute('href')).toBe('/safe');
    expect(anchor?.hasAttribute('aria-label')).toBe(false);
  });

  it('localizes stable issue, external-value, and notification codes without exposing unknown raw values', () => {
    const localization = TestBed.inject(Localization);
    // Nothing is written per code: the code names its own message. A service that spells this
    // `INSUFFICIENT_STOCK` and one that spells it `insufficientStock` reach the same message,
    // because a service changing how it spells a code must not orphan a translation.
    const issueMessages = {
      messages: messages.issue,
      unknown: messages.issue.unknown,
      // What a convention cannot express: a code whose message is named something else.
      bindings: { OUTAGE_1998: { message: messages.issue.legacyOutage } },
    };
    for (const code of [
      'INSUFFICIENT_STOCK',
      'insufficientStock',
      'insufficient-stock',
    ]) {
      expect(presentIssue(localization, { code }, issueMessages)).toMatchObject(
        {
          status: 'known',
          code,
          localized: { value: 'Not enough left in stock.' },
        },
      );
    }
    expect(
      presentIssue(localization, { code: 'OUTAGE_1998' }, issueMessages),
    ).toMatchObject({
      status: 'known',
      localized: { value: 'The service is unavailable.' },
    });
    expect(
      presentIssue(localization, { code: 'required' }, issueMessages),
    ).toMatchObject({
      status: 'known',
      code: 'required',
      localized: { value: 'This value is required.' },
    });
    const unknown = presentIssue(
      localization,
      { code: '<img src=x onerror=alert(1)>' },
      issueMessages,
    );
    expect(unknown).toMatchObject({
      status: 'unknown',
      localized: { value: 'Something went wrong.' },
      diagnostic: { code: 'unknown-presentation-code' },
    });
    expect(unknown.localized.value).not.toContain('<img');
    expect(
      presentExternalValue(
        localization,
        'ready',
        { ready: messages.external.ready },
        messages.issue.unknown,
      ),
    ).toMatchObject({ status: 'known', localized: { value: 'Ready' } });
    expect(
      presentNotification(localization, {
        id: 'saved',
        tone: 'success',
        message: messages.notification.saved,
      }),
    ).toMatchObject({
      id: 'saved',
      tone: 'success',
      content: { value: 'Changes saved.' },
    });
  });

  it('rolls back a coherence-critical adapter that mutates and then fails', async () => {
    TestBed.resetTestingModule();
    let appliedLocale: string | undefined;
    let fail = false;
    const adapter = {
      apply: (snapshot: { readonly primaryLocale: string }) => {
        appliedLocale = snapshot.primaryLocale;
        if (fail) throw new Error('intentional overlay failure');
      },
      rollback: (snapshot: { readonly primaryLocale: string } | undefined) => {
        appliedLocale = snapshot?.primaryLocale;
      },
    };
    await TestBed.configureTestingModule({
      providers: [
        provideLocalizationTesting(
          {
            configuration,
            catalogSet,
            catalogLoaders,
            recoveryPayload,
            extensions: atlasRuntimeExtensions,
          },
          withOverlayLocale(() => adapter),
        ),
      ],
    }).compileComponents();
    const localization = TestBed.inject(Localization);
    await localization.initialize();
    expect(appliedLocale).toBe('en-US');

    fail = true;
    await expect(localization.changeLocale('ar-EG')).resolves.toMatchObject({
      status: 'failed',
    });
    expect(appliedLocale).toBe('en-US');
    expect(localization.snapshot()?.primaryLocale).toBe('en-US');
    expect(document.documentElement.lang).toBe('en-US');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('isolates an explicitly owned child localization context', async () => {
    const parent = TestBed.inject(Localization);
    const child = parent.createChildContext({ initialLocale: 'ar-EG' });
    await child.initialize();

    expect(parent.snapshot()?.primaryLocale).toBe('en-US');
    expect(child.snapshot()?.primaryLocale).toBe('ar-EG');
    expect(child.text(messages.appTitle)).toContain('مختبر');

    child.dispose();
    expect(() => child.text(messages.appTitle)).toThrow(/disposed/u);
    expect(parent.text(messages.appTitle)).toBe('Atlas feature lab');
  });

  it('keeps lazy-scope evaluation behind explicit readiness without hidden loading', async () => {
    const localization = TestBed.inject(Localization);
    expect(() => localization.text(lazyMessages.status)).toThrow(
      /not ready for synchronous evaluation/u,
    );

    await localization.preloadScope(lazyScope);
    expect(() => localization.text(lazyMessages.status)).toThrow(
      /not ready for synchronous evaluation/u,
    );

    await localization.ensureScope(lazyScope);
    expect(localization.text(lazyMessages.status)).toBe('Lazy scope ready.');
    expect(localization.scopeReadiness(lazyScope)().status).toBe('ready');
  });

  it('holds a coordinated commit until every required local scope is ready', async () => {
    const localization = TestBed.inject(Localization);
    const controller = TestBed.inject(LocalizationTestingController);
    const delayed = controller.deferNext(lazyScope, 'ar-EG');
    const transition = localization.changeLocale('ar-EG', {
      mode: 'coordinated',
      requiredScopes: [{ providerId, scopeId }, lazyScope],
    });
    await delayed.started;

    expect(localization.snapshot()?.primaryLocale).toBe('en-US');
    expect(localization.targetLocale()).toBe('ar-EG');
    delayed.release();
    await expect(transition).resolves.toMatchObject({ status: 'committed' });

    expect(localization.snapshot()?.primaryLocale).toBe('ar-EG');
    expect(localization.text(lazyMessages.status)).toContain('جاهز');
  });

  it('honors a new same-locale coordinated scope contract before committing', async () => {
    const localization = TestBed.inject(Localization);
    const controller = TestBed.inject(LocalizationTestingController);
    const delayed = controller.deferNext(lazyScope, 'en-US');
    const transition = localization.changeLocale('en-US', {
      mode: 'coordinated',
      requiredScopes: [{ providerId, scopeId }, lazyScope],
    });
    await delayed.started;

    expect(
      localization
        .snapshot()
        ?.requiredScopes.some(
          ({ providerId: owner, scopeId: id }) =>
            owner === lazyProviderId && id === lazyScopeId,
        ),
    ).toBe(false);
    delayed.release();
    await expect(transition).resolves.toMatchObject({ status: 'committed' });
    expect(
      localization
        .snapshot()
        ?.requiredScopes.some(
          ({ providerId: owner, scopeId: id }) =>
            owner === lazyProviderId && id === lazyScopeId,
        ),
    ).toBe(true);
  });

  it('starts newly requested same-locale progressive scope work', async () => {
    const localization = TestBed.inject(Localization);
    const controller = TestBed.inject(LocalizationTestingController);
    const delayed = controller.deferNext(lazyScope, 'en-US');

    await expect(
      localization.changeLocale('en-US', {
        mode: 'progressive',
        progressiveScopes: [lazyScope],
      }),
    ).resolves.toMatchObject({ status: 'committed' });
    await delayed.started;
    expect(localization.scopeReadiness(lazyScope)().status).toBe('loading');

    delayed.release();
    await vi.waitFor(() => {
      expect(localization.scopeReadiness(lazyScope)().status).toBe('ready');
    });
    expect(localization.text(lazyMessages.status)).toBe('Lazy scope ready.');
  });

  it('commits the primary progressive state while a governed lazy scope remains truthful and pending', async () => {
    const localization = TestBed.inject(Localization);
    const controller = TestBed.inject(LocalizationTestingController);
    const delayed = controller.deferNext(lazyScope, 'ar-EG');

    await expect(
      localization.changeLocale('ar-EG', {
        mode: 'progressive',
        progressiveScopes: [lazyScope],
      }),
    ).resolves.toMatchObject({ status: 'committed' });
    await delayed.started;

    expect(localization.snapshot()?.primaryLocale).toBe('ar-EG');
    expect(localization.scopeReadiness(lazyScope)().status).toBe('loading');
    expect(
      localization
        .snapshot()
        ?.loadedScopes.some(
          ({ providerId: owner, scopeId: id }) =>
            owner === lazyProviderId && id === lazyScopeId,
        ),
    ).toBe(false);

    delayed.release();
    await vi.waitFor(() => {
      expect(localization.scopeReadiness(lazyScope)().status).toBe('ready');
    });
    expect(localization.text(lazyMessages.status)).toContain('جاهز');
  });

  it('folds a required scope still in flight into the transaction that starts beside it', async () => {
    const localization = TestBed.inject(Localization);
    const controller = TestBed.inject(LocalizationTestingController);
    const outgoing = controller.deferNext(lazyScope, 'en-US');
    const incoming = controller.deferNext(lazyScope, 'ar-EG');

    const readiness = localization.ensureScope(lazyScope);
    await outgoing.started;

    // Nobody passes this scope to the switch: the two callers do not know about each other. The
    // switch requesting it for ar-EG is the fold, and it is what `incoming.started` observes.
    const transition = localization.changeLocale('ar-EG');
    await incoming.started;
    expect(localization.snapshot()?.primaryLocale).toBe('en-US');

    // Released here rather than after the commit, and the reason is not about this rule: acquiring
    // a scope acquires the source-locale catalog too, as the fallback, so a deferred en-US load
    // holds the entry ar-EG's own acquisition coalesces onto. Holding it across the commit would
    // deadlock the transaction on the test's gate rather than on anything the runtime decided.
    outgoing.release();
    await expect(readiness).resolves.toBeUndefined();

    incoming.release();
    await expect(transition).resolves.toMatchObject({ status: 'committed' });
    expect(localization.snapshot()?.primaryLocale).toBe('ar-EG');
    expect(localization.text(lazyMessages.status)).toContain('جاهز');
  });

  it('lands a progressive scope after its own transaction has committed, as a transaction', async () => {
    const localization = TestBed.inject(Localization);
    const controller = TestBed.inject(LocalizationTestingController);
    const delayed = controller.deferNext(lazyScope, 'ar-EG');

    await expect(
      localization.changeLocale('ar-EG', {
        mode: 'progressive',
        progressiveScopes: [lazyScope],
      }),
    ).resolves.toMatchObject({ status: 'committed' });
    await delayed.started;

    const committed = localization.snapshot()?.id as number;
    delayed.release();
    await vi.waitFor(() => {
      expect(localization.scopeReadiness(lazyScope)().status).toBe('ready');
    });

    // One publish, not a mutation of the committed snapshot and not a locale change.
    expect(localization.snapshot()?.id).toBe(committed + 1);
    expect(localization.snapshot()?.primaryLocale).toBe('ar-EG');
    expect(localization.text(lazyMessages.status)).toContain('جاهز');
  });

  it('discards a load whose snapshot was superseded, and answers the request that outlived it', async () => {
    const localization = TestBed.inject(Localization);
    const controller = TestBed.inject(LocalizationTestingController);

    // ar-EG first, so the deferred load is not the scope's source catalog. Acquiring a scope
    // acquires the source locale beside the target, as the fallback, and deferring en-US here
    // would gate the very entry the other locale's acquisition coalesces onto.
    await expect(localization.changeLocale('ar-EG')).resolves.toMatchObject({
      status: 'committed',
    });

    const stale = controller.deferNext(lazyScope, 'ar-EG');
    const readiness = localization.ensureScope(lazyScope);
    await stale.started;

    // The switch folds the outstanding request in and re-requests for en-US, which is already in
    // the store because the ar-EG request loaded it as the fallback, so this commits without
    // waiting on the load it is superseding. Nothing waits on a load that is not required.
    await expect(localization.changeLocale('en-US')).resolves.toMatchObject({
      status: 'committed',
    });
    TestBed.tick();
    const committed = localization.snapshot()?.id as number;

    stale.release();
    await expect(readiness).resolves.toBeUndefined();

    // The ar-EG content is for a locale that will never be current again: it published nothing,
    // and the request it belonged to was answered by the transaction that carried the scope.
    expect(localization.snapshot()?.id).toBe(committed);
    expect(localization.snapshot()?.primaryLocale).toBe('en-US');
    expect(localization.text(lazyMessages.status)).toBe('Lazy scope ready.');
  });

  it('resolves the built toolkit and its installed parser dependencies', () => {
    const result = parseAtlasConfiguration(
      JSON.stringify({
        schemaVersion: 1,
        sourceLocale: 'EN-us',
        defaultLocale: 'EN-us',
        locales: ['EN-us'],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sourceLocale).toBe('en-US');
  });
});
