import {
  buildLocalizedRoute,
  createLocalizationContext,
  projectRouteSeo,
  resolveLocalizedRoute,
  type Localization,
  type LocalizationParticipant,
  type LocalizationParticipantCommitReport,
  type LocalizationParticipantContext,
  type LocalizationParticipantReport,
  type RouteParameterContext,
  type RouteParameterCodec,
  type RouteRuntimeProjection,
} from '@neolorn/atlas';
import { ControllableLocalizationParticipant } from '@neolorn/atlas/testing';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { providerId, scopeId } from '#i18n/shell';

import {
  DynamicContentStore,
  FEATURE_ARTICLE_ID,
  MemoryFeatureArticleSource,
  type FeatureArticleSource,
  type FeatureArticleSourceOutcome,
} from './dynamic-content';
import { atlasRuntimeExtensions } from './runtime-extensions';
import {
  articleSlugCodec,
  routePolicy,
  appRouteProjection,
} from './localization.routes';

const scope = Object.freeze({ providerId, scopeId });

function localization(): Localization {
  return createLocalizationContext({
    setup: {
      configuration,
      catalogSet,
      catalogLoaders,
      extensions: atlasRuntimeExtensions,
    },
    bootstrapScopes: [scope],
  });
}

function ready(locale: 'en-US' | 'ar-EG'): LocalizationParticipantCommitReport {
  return Object.freeze({
    status: 'ready',
    representation: Object.freeze({
      kind: 'locale-bound',
      supplyingLocale: locale,
      direction: locale === 'ar-EG' ? 'rtl' : 'ltr',
    }),
    identity: Object.freeze({
      resourceId: 'article:atlas-handbook',
      representationId: locale === 'ar-EG' ? 'article-ar' : 'article-en',
      revision: 'r1',
      correlationId: `fixture:${locale}:r1`,
    }),
  });
}

function forwardParticipant(
  controller: ControllableLocalizationParticipant,
  commit?: (
    context: LocalizationParticipantContext,
    report: LocalizationParticipantCommitReport,
  ) => void,
): LocalizationParticipant {
  return Object.freeze({
    id: controller.id,
    prepare: (context: LocalizationParticipantContext) =>
      controller.prepare(context),
    commit: (
      context: LocalizationParticipantContext,
      report: LocalizationParticipantCommitReport,
    ) =>
      commit === undefined
        ? controller.commit(context, report)
        : commit(context, report),
    rollback: (
      context: LocalizationParticipantContext,
      report: LocalizationParticipantCommitReport,
    ) => controller.rollback(context, report),
    discard: (
      context: LocalizationParticipantContext,
      report?: LocalizationParticipantReport,
    ) => controller.discard(context, report),
    dispose: () => controller.dispose(),
  });
}

describe('participant contracts and transactions', () => {
  it('rejects payload-shaped participant reports and publishes only bounded metadata', async () => {
    const runtime = localization();
    runtime.registerParticipant({
      id: 'malicious-payload',
      prepare: () =>
        ({
          ...ready('en-US'),
          payload: {
            title: 'This consumer payload must never enter Atlas state.',
          },
        }) as unknown as LocalizationParticipantReport,
    });

    await expect(runtime.initialize()).rejects.toMatchObject({
      diagnostic: { code: 'participant-contract-rejected' },
    });
    expect(runtime.snapshot()).toBeUndefined();
    expect(JSON.stringify(runtime.participants())).not.toContain(
      'This consumer payload',
    );
    runtime.dispose();
  });

  it('accepts every truthful representation class as immutable metadata', async () => {
    const runtime = localization();
    const reports: readonly LocalizationParticipantCommitReport[] = [
      ready('en-US'),
      Object.freeze({
        status: 'ready',
        representation: Object.freeze({
          kind: 'language-independent',
          direction: 'ltr',
        }),
      }),
      Object.freeze({
        status: 'ready',
        representation: Object.freeze({
          kind: 'user-authored',
          language: 'ar',
          direction: 'rtl',
        }),
      }),
      Object.freeze({
        status: 'ready',
        representation: Object.freeze({
          kind: 'multilingual',
          languages: Object.freeze([
            Object.freeze({ language: 'en', direction: 'ltr' }),
            Object.freeze({ language: 'ar', direction: 'rtl' }),
          ]),
        }),
      }),
      Object.freeze({
        status: 'ready',
        representation: Object.freeze({
          kind: 'fixed-language',
          language: 'fr',
          direction: 'ltr',
        }),
      }),
      Object.freeze({
        status: 'ready',
        representation: Object.freeze({ kind: 'unknown-language' }),
      }),
    ];
    for (const [index, report] of reports.entries()) {
      runtime.registerParticipant({
        id: `representation-${index}`,
        prepare: () => report,
      });
    }
    await runtime.initialize();

    expect(
      runtime
        .participants()
        .map(({ current }) =>
          current?.report.status === 'ready'
            ? current.report.representation.kind
            : undefined,
        ),
    ).toEqual([
      'locale-bound',
      'language-independent',
      'user-authored',
      'multilingual',
      'fixed-language',
      'unknown-language',
    ]);
    for (const state of runtime.participants()) {
      expect(Object.isFrozen(state)).toBe(true);
      expect(Object.isFrozen(state.current?.report)).toBe(true);
      if (state.current?.report.status === 'ready') {
        expect(Object.isFrozen(state.current.report.representation)).toBe(true);
      }
    }
    runtime.dispose();
  });

  it('waits for required participants and preserves the prior coherent view on unavailability', async () => {
    const runtime = localization();
    const participant = new ControllableLocalizationParticipant(
      'required-article',
      ready('en-US'),
    );
    const registration = runtime.registerParticipant(participant, {
      coordination: 'required',
    });
    await runtime.initialize();

    const unavailable = participant.deferNext();
    const failedSwitch = runtime.changeLocale('ar-EG', {
      mode: 'coordinated',
    });
    const context = await unavailable.started;
    expect(context).toMatchObject({
      targetLocale: 'ar-EG',
      formatting: { locale: 'ar-EG' },
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.formatting)).toBe(true);
    expect(runtime.snapshot()?.primaryLocale).toBe('en-US');
    expect(runtime.targetLocale()).toBe('ar-EG');
    unavailable.complete(
      Object.freeze({
        status: 'unavailable',
        outcome: 'localized-representation-unavailable',
        identity: Object.freeze({ resourceId: 'article:atlas-handbook' }),
      }),
    );
    await expect(failedSwitch).resolves.toMatchObject({
      status: 'failed',
      diagnostic: {
        code: 'participant-unavailable',
        outcome: 'localized-representation-unavailable',
      },
    });
    expect(runtime.snapshot()?.primaryLocale).toBe('en-US');
    expect(registration.state()).toMatchObject({
      current: { targetLocale: 'en-US', report: { status: 'ready' } },
      attempt: { targetLocale: 'ar-EG', status: 'unavailable' },
    });

    const retry = participant.deferNext();
    const committedSwitch = runtime.changeLocale('ar-EG');
    await retry.started;
    retry.complete(ready('ar-EG'));
    await expect(committedSwitch).resolves.toMatchObject({
      status: 'committed',
      snapshot: { primaryLocale: 'ar-EG' },
    });
    expect(registration.state().current).toMatchObject({
      targetLocale: 'ar-EG',
      report: { status: 'ready' },
    });
    runtime.dispose();
  });

  it('commits primary UI first in progressive mode and completes the region independently', async () => {
    const runtime = localization();
    const participant = new ControllableLocalizationParticipant(
      'progressive-article',
      ready('en-US'),
    );
    const registration = runtime.registerParticipant(participant, {
      coordination: 'required',
    });
    await runtime.initialize();

    const deferred = participant.deferNext();
    const result = await runtime.changeLocale('ar-EG', {
      mode: 'progressive',
    });
    await deferred.started;
    expect(result).toMatchObject({ status: 'committed' });
    expect(runtime.snapshot()?.primaryLocale).toBe('ar-EG');
    expect(registration.state()).toMatchObject({
      current: { targetLocale: 'en-US' },
      attempt: { targetLocale: 'ar-EG', status: 'preparing' },
    });

    deferred.complete(ready('ar-EG'));
    await vi.waitFor(() => {
      expect(registration.state().current?.targetLocale).toBe('ar-EG');
    });
    expect(runtime.snapshot()?.primaryLocale).toBe('ar-EG');
    runtime.dispose();
  });

  it('keeps domain outcomes distinct from unavailable and operational failures', async () => {
    const runtime = localization();
    const participant = new ControllableLocalizationParticipant(
      'outcome-article',
      ready('en-US'),
    );
    const registration = runtime.registerParticipant(participant);
    await runtime.initialize();

    const domain = participant.deferNext();
    const domainSwitch = runtime.changeLocale('ar-EG');
    await domain.started;
    domain.complete(
      Object.freeze({
        status: 'domain-outcome',
        outcome: 'consumer-domain-outcome',
        code: 'article-not-found',
        identity: Object.freeze({ resourceId: 'article:missing' }),
      }),
    );
    await expect(domainSwitch).resolves.toMatchObject({ status: 'committed' });
    expect(registration.state().current?.report).toMatchObject({
      status: 'domain-outcome',
      outcome: 'consumer-domain-outcome',
      code: 'article-not-found',
    });

    const operational = participant.deferNext();
    const operationalSwitch = runtime.changeLocale('en-US');
    await operational.started;
    operational.fail('environment-failure');
    await expect(operationalSwitch).resolves.toMatchObject({
      status: 'failed',
      diagnostic: {
        code: 'participant-failed',
        outcome: 'operational-failure',
      },
    });
    expect(runtime.snapshot()?.primaryLocale).toBe('ar-EG');
    runtime.dispose();
  });

  it('cancels stale participant work and ignores late completion', async () => {
    const runtime = localization();
    const participant = new ControllableLocalizationParticipant(
      'racing-article',
      ready('en-US'),
    );
    const registration = runtime.registerParticipant(participant);
    await runtime.initialize();

    const stale = participant.deferNext();
    const arabic = runtime.changeLocale('ar-EG');
    const staleContext = await stale.started;
    const english = runtime.changeLocale('en-US');
    await expect(arabic).resolves.toMatchObject({ status: 'superseded' });
    await expect(english).resolves.toMatchObject({ status: 'committed' });
    expect(staleContext.signal.aborted).toBe(true);

    stale.complete(ready('ar-EG'));
    await Promise.resolve();
    expect(registration.state().current?.targetLocale).toBe('en-US');
    expect(participant.committed.at(-1)?.identity?.representationId).toBe(
      'article-en',
    );
    runtime.dispose();
  });

  it('enforces participant deadlines without changing the committed snapshot', async () => {
    const runtime = localization();
    const participant = new ControllableLocalizationParticipant(
      'deadline-article',
      ready('en-US'),
    );
    const registration = runtime.registerParticipant(participant, {
      deadlineMilliseconds: 5,
    });
    await runtime.initialize();

    const late = participant.deferNext();
    const transition = runtime.changeLocale('ar-EG');
    await late.started;
    await expect(transition).resolves.toMatchObject({
      status: 'failed',
      diagnostic: { code: 'participant-timeout' },
    });
    expect(runtime.snapshot()?.primaryLocale).toBe('en-US');
    expect(registration.state().attempt).toMatchObject({
      status: 'failed',
      diagnostic: { code: 'participant-timeout' },
    });
    late.complete(ready('ar-EG'));
    await Promise.resolve();
    expect(registration.state().current?.targetLocale).toBe('en-US');
    runtime.dispose();
  });

  it('rolls back every already-invoked participant when a later commit fails', async () => {
    const runtime = localization();
    const first = new ControllableLocalizationParticipant(
      'commit-first',
      ready('en-US'),
    );
    const second = new ControllableLocalizationParticipant(
      'commit-second',
      ready('en-US'),
    );
    const firstRegistration = runtime.registerParticipant(first);
    const secondRegistration = runtime.registerParticipant(
      forwardParticipant(second, (context, report) => {
        second.commit(context, report);
        if (context.targetLocale === 'ar-EG') {
          throw new Error('Consumer commit failure');
        }
      }),
    );
    await runtime.initialize();
    await expect(runtime.changeLocale('ar-EG')).resolves.toMatchObject({
      status: 'failed',
      diagnostic: { code: 'participant-failed' },
    });
    expect(runtime.snapshot()?.primaryLocale).toBe('en-US');
    expect(first.rolledBack.at(-1)?.identity?.representationId).toBe(
      'article-en',
    );
    expect(second.rolledBack.length).toBeGreaterThan(0);
    expect(firstRegistration.state().current?.targetLocale).toBe('en-US');
    expect(secondRegistration.state().current?.targetLocale).toBe('en-US');
    expect(firstRegistration.state().attempt.status).toBe('cancelled');
    expect(secondRegistration.state().attempt.status).toBe('failed');
    runtime.dispose();
  });

  it('does not commit a participant unregistered by an earlier cohort member', async () => {
    const runtime = localization();
    const first = new ControllableLocalizationParticipant(
      'unregister-first',
      ready('en-US'),
    );
    const second = new ControllableLocalizationParticipant(
      'unregister-second',
      ready('en-US'),
    );
    let secondRegistration!: ReturnType<Localization['registerParticipant']>;
    runtime.registerParticipant(
      forwardParticipant(first, (context, report) => {
        first.commit(context, report);
        if (context.targetLocale === 'ar-EG') secondRegistration.unregister();
      }),
    );
    secondRegistration = runtime.registerParticipant(second);
    await runtime.initialize();

    await expect(runtime.changeLocale('ar-EG')).resolves.toMatchObject({
      status: 'failed',
      diagnostic: { code: 'disposed', participantId: 'unregister-second' },
    });
    expect(runtime.snapshot()?.primaryLocale).toBe('en-US');
    expect(second.committed).toHaveLength(1);
    expect(second.disposeCount).toBe(1);
    expect(first.rolledBack.length).toBeGreaterThan(0);
    runtime.dispose();
  });
});

describe('consumer custody and source neutrality', () => {
  it('substitutes consumer sources without changing the Atlas participant contract', async () => {
    const outcomes: {
      readonly state: unknown;
      readonly sourceLabel: string | undefined;
      readonly payloadMarker: string | undefined;
      readonly sourceRequests: number;
    }[] = [];

    for (const source of [
      new MemoryFeatureArticleSource('source-a', 'Consumer source A'),
      new MemoryFeatureArticleSource('source-b', 'Consumer source B'),
    ]) {
      const store = new DynamicContentStore(source);
      const runtime = localization();
      const registration = runtime.registerParticipant(store.participant);
      store.attach(registration);
      await runtime.initialize();
      outcomes.push({
        state: registration.state().current?.report,
        sourceLabel: store.article()?.sourceLabel,
        payloadMarker: store.article()?.payloadMarker,
        sourceRequests: source.requestCount,
      });
      expect(JSON.stringify(registration.state())).not.toContain(
        'consumer-owned-dynamic-payload',
      );
      expect(JSON.stringify(registration.state())).not.toContain(
        store.article()?.title as string,
      );
      runtime.dispose();
    }

    expect(outcomes.map(({ state }) => state)).toEqual([
      expect.objectContaining({
        status: 'ready',
        representation: expect.objectContaining({ kind: 'locale-bound' }),
      }),
      expect.objectContaining({
        status: 'ready',
        representation: expect.objectContaining({ kind: 'locale-bound' }),
      }),
    ]);
    expect(outcomes.map(({ sourceLabel }) => sourceLabel)).toEqual([
      'Consumer source A',
      'Consumer source B',
    ]);
    expect(outcomes.map(({ payloadMarker }) => payloadMarker)).toEqual([
      'consumer-owned-dynamic-payload',
      'consumer-owned-dynamic-payload',
    ]);
    expect(outcomes.map(({ sourceRequests }) => sourceRequests)).toEqual([
      1, 1,
    ]);
  });

  it('keeps skeleton, retain, hide, substitute, and retry policy in the consumer store', async () => {
    const base = new MemoryFeatureArticleSource(
      'source-a',
      'Consumer source A',
    );
    let release!: (outcome: FeatureArticleSourceOutcome) => void;
    let started!: () => void;
    let deferArabic = true;
    const pendingStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const source: FeatureArticleSource = {
      id: 'deferred-source',
      get requestCount() {
        return base.requestCount;
      },
      load: (entityId, locale, signal) => {
        if (locale === 'en-US' || !deferArabic) {
          return base.load(entityId, locale, signal);
        }
        deferArabic = false;
        started();
        return new Promise<FeatureArticleSourceOutcome>((resolve) => {
          release = resolve;
        });
      },
    };
    const store = new DynamicContentStore(source);
    const runtime = localization();
    const registration = runtime.registerParticipant(store.participant);
    store.attach(registration);
    await runtime.initialize();

    const transition = runtime.changeLocale('ar-EG', { mode: 'progressive' });
    await pendingStarted;
    await expect(transition).resolves.toMatchObject({ status: 'committed' });
    expect(store.presentation()).toMatchObject({
      kind: 'retained',
      article: { supplyingLocale: 'en-US' },
    });
    store.setPresentationPolicy('skeleton');
    expect(store.presentation()).toEqual({ kind: 'skeleton' });
    store.setPresentationPolicy('hide');
    expect(store.presentation()).toEqual({ kind: 'hidden' });
    store.setPresentationPolicy('substitute');
    expect(store.presentation()).toEqual({ kind: 'substitute' });

    release(
      await base.load(
        FEATURE_ARTICLE_ID,
        'ar-EG',
        new AbortController().signal,
      ),
    );
    await vi.waitFor(() => {
      expect(store.article()?.supplyingLocale).toBe('ar-EG');
      expect(registration.state().current?.targetLocale).toBe('ar-EG');
    });
    await expect(store.retry()).resolves.toMatchObject({
      current: { targetLocale: 'ar-EG' },
    });
    runtime.dispose();
  });

  it('keeps multilingual and non-localized payload semantics consumer-owned and truthful', async () => {
    const source = new MemoryFeatureArticleSource(
      'source-a',
      'Consumer source A',
    );
    const outcome = await source.load(
      FEATURE_ARTICLE_ID,
      'en-US',
      new AbortController().signal,
    );
    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') return;
    expect(
      outcome.article.comments.map(({ representation }) => representation.kind),
    ).toEqual([
      'user-authored',
      'multilingual',
      'language-independent',
      'fixed-language',
      'unknown-language',
    ]);
    expect(outcome.article.comments[0]?.representation).toMatchObject({
      kind: 'user-authored',
      language: 'ar',
      direction: 'rtl',
    });
    expect(outcome.article.comments[1]?.representation).toMatchObject({
      kind: 'multilingual',
      languages: [
        { language: 'en', direction: 'ltr' },
        { language: 'ar', direction: 'rtl' },
      ],
    });
  });
});

describe('dynamic route equivalence and truthful SEO', () => {
  it('resolves localized slugs to one entity and canonicalizes cross-language aliases', () => {
    expect(
      buildLocalizedRoute(routePolicy, appRouteProjection, 'article', 'en-US', {
        slug: FEATURE_ARTICLE_ID,
      }),
    ).toBe('/en-us/articles/atlas-handbook');
    expect(
      buildLocalizedRoute(routePolicy, appRouteProjection, 'article', 'ar-EG', {
        slug: FEATURE_ARTICLE_ID,
      }),
    ).toBe('/ar-eg/articles/%D8%AF%D9%84%D9%8A%D9%84-%D8%A3%D8%B7%D9%84%D8%B3');

    expect(
      resolveLocalizedRoute(
        '/ar-eg/articles/atlas-handbook',
        routePolicy,
        appRouteProjection,
      ),
    ).toMatchObject({
      status: 'redirect',
      reason: 'canonical-correction',
      location:
        '/ar-eg/articles/%D8%AF%D9%84%D9%8A%D9%84-%D8%A3%D8%B7%D9%84%D8%B3',
    });
    const arabic = resolveLocalizedRoute(
      '/ar-eg/articles/%D8%AF%D9%84%D9%8A%D9%84-%D8%A3%D8%B7%D9%84%D8%B3',
      routePolicy,
      appRouteProjection,
    );
    expect(arabic).toMatchObject({
      status: 'success',
      locale: 'ar-EG',
      parameters: { slug: FEATURE_ARTICLE_ID },
    });
  });

  /** As `direct-api-contracts.spec.ts`: the locales a production build of this fixture generates. */
  const shippedLocales = Object.freeze(['en-US', 'ar-EG']);

  it('projects locale-specific entity alternates and omits unavailable representations', () => {
    const english = resolveLocalizedRoute(
      '/en-us/articles/atlas-handbook',
      routePolicy,
      appRouteProjection,
    );
    expect(english.status).toBe('success');
    if (english.status !== 'success') return;
    expect(
      projectRouteSeo(
        english,
        routePolicy,
        appRouteProjection,
        { ...configuration, locales: shippedLocales },
        'https://atlas.example',
      ).alternates,
    ).toEqual([
      {
        locale: 'en-US',
        hreflang: 'en-US',
        url: 'https://atlas.example/en-us/articles/atlas-handbook',
      },
      {
        locale: 'ar-EG',
        hreflang: 'ar-EG',
        url: 'https://atlas.example/ar-eg/articles/%D8%AF%D9%84%D9%8A%D9%84-%D8%A3%D8%B7%D9%84%D8%B3',
      },
    ]);

    const englishOnlySlugCodec: RouteParameterCodec<string> = Object.freeze({
      parse: articleSlugCodec.parse,
      serialize: (value: string, context?: RouteParameterContext) =>
        context?.locale === 'ar-EG'
          ? undefined
          : articleSlugCodec.serialize(value, context),
    });
    const englishOnly: RouteRuntimeProjection = Object.freeze({
      ...appRouteProjection,
      parameters: Object.freeze({
        ...appRouteProjection.parameters,
        article: Object.freeze({
          slug: englishOnlySlugCodec,
        }),
      }),
    });
    expect(
      projectRouteSeo(
        english,
        routePolicy,
        englishOnly,
        { ...configuration, locales: shippedLocales },
        'https://atlas.example',
      ).alternates,
    ).toEqual([
      {
        locale: 'en-US',
        hreflang: 'en-US',
        url: 'https://atlas.example/en-us/articles/atlas-handbook',
      },
    ]);
  });
});
