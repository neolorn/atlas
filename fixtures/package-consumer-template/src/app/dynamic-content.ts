import { isPlatformBrowser, isPlatformServer } from '@angular/common';
import {
  InjectionToken,
  PLATFORM_ID,
  TransferState,
  computed,
  inject,
  makeEnvironmentProviders,
  makeStateKey,
  provideEnvironmentInitializer,
  signal,
  type EnvironmentProviders,
  type Signal,
} from '@angular/core';
import {
  Localization,
  type LocaleDirection,
  type LocalizationParticipant,
  type LocalizationParticipantCommitReport,
  type LocalizationParticipantContext,
  type LocalizationParticipantRegistration,
  type LocalizationParticipantRepresentation,
  type LocalizationParticipantState,
} from '@neolorn/atlas';

export const FEATURE_ARTICLE_ID = 'atlas-handbook';

export interface FeatureComment {
  readonly id: string;
  readonly text: string;
  readonly representation: LocalizationParticipantRepresentation;
}

export interface FeatureArticle {
  readonly entityId: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly supplyingLocale: string;
  readonly direction: LocaleDirection;
  readonly sourceLabel: string;
  readonly revision: string;
  readonly payloadMarker: 'consumer-owned-dynamic-payload';
  readonly comments: readonly FeatureComment[];
}

export type FeatureArticleSourceOutcome =
  | {
      readonly status: 'ready';
      readonly article: FeatureArticle;
    }
  | { readonly status: 'unavailable' }
  | { readonly status: 'domain-outcome'; readonly code: string };

export interface FeatureArticleSource {
  readonly id: string;
  readonly requestCount: number;
  load(
    entityId: string,
    targetLocale: string,
    signal: AbortSignal,
  ): PromiseLike<FeatureArticleSourceOutcome>;
}

const COMMENTS: readonly FeatureComment[] = Object.freeze([
  Object.freeze({
    id: 'community-ar',
    text: 'واجهة واضحة وسهلة الاستخدام',
    representation: Object.freeze({
      kind: 'user-authored',
      language: 'ar',
      direction: 'rtl',
    }),
  }),
  Object.freeze({
    id: 'community-multilingual',
    text: 'Atlas works: أطلس يعمل',
    representation: Object.freeze({
      kind: 'multilingual',
      languages: Object.freeze([
        Object.freeze({ language: 'en', direction: 'ltr' }),
        Object.freeze({ language: 'ar', direction: 'rtl' }),
      ]),
    }),
  }),
  Object.freeze({
    id: 'rating',
    text: '★★★★★',
    representation: Object.freeze({ kind: 'language-independent' }),
  }),
  Object.freeze({
    id: 'fixed-fr',
    text: 'Documentation communautaire',
    representation: Object.freeze({
      kind: 'fixed-language',
      language: 'fr',
      direction: 'ltr',
    }),
  }),
  Object.freeze({
    id: 'unknown',
    text: 'N/A',
    representation: Object.freeze({ kind: 'unknown-language' }),
  }),
]);

const ARTICLES = Object.freeze({
  'en-US': Object.freeze({
    slug: 'atlas-handbook',
    title: 'The Atlas localization handbook',
    summary: 'Consumer-owned content coordinated through metadata only.',
    direction: 'ltr' as const,
  }),
  'ar-EG': Object.freeze({
    slug: 'دليل-أطلس',
    title: 'دليل أطلس للترجمة',
    summary: 'محتوى يملكه التطبيق وينسقه أطلس عبر البيانات الوصفية فقط.',
    direction: 'rtl' as const,
  }),
});

export class MemoryFeatureArticleSource implements FeatureArticleSource {
  private requests = 0;

  constructor(
    readonly id: 'source-a' | 'source-b',
    private readonly label: string,
  ) {}

  get requestCount(): number {
    return this.requests;
  }

  load(
    entityId: string,
    targetLocale: string,
    signal: AbortSignal,
  ): PromiseLike<FeatureArticleSourceOutcome> {
    this.requests += 1;
    if (signal.aborted) return Promise.reject(signal.reason);
    if (entityId !== FEATURE_ARTICLE_ID) {
      return Promise.resolve(
        Object.freeze({
          status: 'domain-outcome',
          code: 'article-not-found',
        }),
      );
    }
    // Content this application owns, for a locale it has no content in.
    //
    // Atlas transforms catalogs. It never sees an article title, so a pseudo-locale has no
    // pseudo-localized article and nothing could produce one: the text is in a store Atlas has
    // no access to. An application still has to answer, and answering `unavailable` for every
    // locale outside this table makes the page unopenable: the participant is required, so a
    // pseudo-locale build fails to render at all rather than rendering something a developer can
    // look at.
    //
    // So the source locale's representation is supplied and `supplyingLocale` says so, which is
    // the same decision this fixture already made one layer up: `articleSlugCodec` serializes the
    // English spelling for every locale but `ar-EG`, so `/en-arab-xb/articles/atlas-handbook` is
    // already addressing the English article.
    //
    // The consequence is the point rather than a compromise. On a pseudo-locale page every Atlas
    // message carries its markers and this title does not, which is exactly what an untransformed
    // string is supposed to look like, and content that never went through Atlas is the largest
    // class of them.
    const representation =
      ARTICLES[targetLocale as keyof typeof ARTICLES] ?? ARTICLES['en-US'];
    if (representation === undefined) {
      return Promise.resolve(Object.freeze({ status: 'unavailable' }));
    }
    const supplyingLocale =
      targetLocale in ARTICLES ? targetLocale : ('en-US' as const);
    return Promise.resolve(
      Object.freeze({
        status: 'ready',
        article: Object.freeze({
          entityId,
          slug: representation.slug,
          title: representation.title,
          summary: representation.summary,
          supplyingLocale,
          direction: representation.direction,
          sourceLabel: this.label,
          revision: this.id === 'source-a' ? 'a-1' : 'b-1',
          payloadMarker: 'consumer-owned-dynamic-payload',
          comments: COMMENTS,
        }),
      }),
    );
  }
}

interface FeatureArticleTransfer {
  readonly profile: 'atlas-feature-article-transfer/1';
  readonly article: FeatureArticle;
  readonly report: LocalizationParticipantCommitReport;
}

interface FeatureArticleTransferPort {
  readonly initial?: FeatureArticleTransfer;
  write(value: FeatureArticleTransfer): void;
}

interface StagedArticle {
  readonly report: LocalizationParticipantCommitReport;
  readonly article?: FeatureArticle;
  readonly previousArticle?: FeatureArticle;
  readonly previousReport?: LocalizationParticipantCommitReport;
}

export type DynamicPresentationPolicy =
  | 'retain'
  | 'skeleton'
  | 'hide'
  | 'substitute';

export interface DynamicArticlePresentation {
  readonly kind: 'content' | 'retained' | 'skeleton' | 'hidden' | 'substitute';
  readonly article?: FeatureArticle;
}

function sameIdentity(
  left: LocalizationParticipantCommitReport,
  right: LocalizationParticipantCommitReport,
): boolean {
  return (
    left.identity?.resourceId === right.identity?.resourceId &&
    left.identity?.representationId === right.identity?.representationId &&
    left.identity?.revision === right.identity?.revision &&
    left.identity?.correlationId === right.identity?.correlationId
  );
}

export class DynamicContentStore {
  private readonly articleValue = signal<FeatureArticle | undefined>(undefined);
  private readonly reportValue = signal<
    LocalizationParticipantCommitReport | undefined
  >(undefined);
  private readonly pendingTransitionValue = signal<number | undefined>(
    undefined,
  );
  private readonly policyValue = signal<DynamicPresentationPolicy>('retain');
  private readonly staged = new Map<number, StagedArticle>();
  private readonly committed = new Map<number, StagedArticle>();
  private registration: LocalizationParticipantRegistration | undefined;
  private adopted: FeatureArticleTransfer | undefined;

  readonly article = this.articleValue.asReadonly();
  readonly report = this.reportValue.asReadonly();
  readonly pending = computed(
    () => this.pendingTransitionValue() !== undefined,
  );
  readonly presentationPolicy = this.policyValue.asReadonly();
  readonly participantState: Signal<LocalizationParticipantState | undefined> =
    computed(() => this.registration?.state());
  readonly presentation: Signal<DynamicArticlePresentation> = computed(() => {
    const article = this.articleValue();
    if (!this.pending()) {
      return Object.freeze({
        kind: 'content',
        ...(article === undefined ? {} : { article }),
      });
    }
    switch (this.policyValue()) {
      case 'retain':
        return Object.freeze({
          kind: article === undefined ? 'skeleton' : 'retained',
          ...(article === undefined ? {} : { article }),
        });
      case 'skeleton':
        return Object.freeze({ kind: 'skeleton' });
      case 'hide':
        return Object.freeze({ kind: 'hidden' });
      case 'substitute':
        return Object.freeze({ kind: 'substitute' });
    }
  });

  readonly participant: LocalizationParticipant = Object.freeze({
    id: 'feature-article',
    prepare: (context: LocalizationParticipantContext) => this.prepare(context),
    commit: (
      context: LocalizationParticipantContext,
      report: LocalizationParticipantCommitReport,
    ) => this.commit(context, report),
    rollback: (
      context: LocalizationParticipantContext,
      report: LocalizationParticipantCommitReport,
    ) => this.rollback(context, report),
    discard: (context: LocalizationParticipantContext) => this.discard(context),
    dispose: () => {
      this.staged.clear();
      this.committed.clear();
    },
  });

  constructor(
    readonly source: FeatureArticleSource,
    private readonly transfer?: FeatureArticleTransferPort,
  ) {
    this.adopted = transfer?.initial;
    if (this.adopted !== undefined) {
      this.articleValue.set(this.adopted.article);
      this.reportValue.set(this.adopted.report);
    }
  }

  attach(registration: LocalizationParticipantRegistration): void {
    this.registration = registration;
  }

  setPresentationPolicy(policy: DynamicPresentationPolicy): void {
    this.policyValue.set(policy);
  }

  retry(): Promise<LocalizationParticipantState> {
    if (this.registration === undefined) {
      return Promise.reject(new Error('The dynamic participant is detached.'));
    }
    return this.registration.retry();
  }

  private async prepare(
    context: LocalizationParticipantContext,
  ): Promise<LocalizationParticipantCommitReport> {
    this.pendingTransitionValue.set(context.transitionId);
    const transferred = context.transferred;
    const adopted = this.adopted;
    if (
      transferred !== undefined &&
      adopted !== undefined &&
      adopted.article.supplyingLocale === context.targetLocale &&
      sameIdentity(transferred.report, adopted.report)
    ) {
      this.adopted = undefined;
      const previousArticle = this.articleValue();
      const previousReport = this.reportValue();
      this.staged.set(context.transitionId, {
        report: transferred.report,
        article: adopted.article,
        ...(previousArticle === undefined ? {} : { previousArticle }),
        ...(previousReport === undefined ? {} : { previousReport }),
      });
      return transferred.report;
    }
    this.adopted = undefined;
    const outcome = await this.source.load(
      FEATURE_ARTICLE_ID,
      context.targetLocale,
      context.signal,
    );
    if (context.signal.aborted) throw context.signal.reason;
    const previousArticle = this.articleValue();
    const previousReport = this.reportValue();
    if (outcome.status === 'unavailable') {
      const report: LocalizationParticipantCommitReport = Object.freeze({
        status: 'unavailable',
        outcome: 'localized-representation-unavailable',
        identity: Object.freeze({
          resourceId: `article:${FEATURE_ARTICLE_ID}`,
        }),
      });
      this.staged.set(context.transitionId, {
        report,
        ...(previousArticle === undefined ? {} : { previousArticle }),
        ...(previousReport === undefined ? {} : { previousReport }),
      });
      return report;
    }
    if (outcome.status === 'domain-outcome') {
      const report: LocalizationParticipantCommitReport = Object.freeze({
        status: 'domain-outcome',
        outcome: 'consumer-domain-outcome',
        code: outcome.code,
        identity: Object.freeze({
          resourceId: `article:${FEATURE_ARTICLE_ID}`,
        }),
      });
      this.staged.set(context.transitionId, {
        report,
        ...(previousArticle === undefined ? {} : { previousArticle }),
        ...(previousReport === undefined ? {} : { previousReport }),
      });
      return report;
    }
    const article = outcome.article;
    const report: LocalizationParticipantCommitReport = Object.freeze({
      status: 'ready',
      representation: Object.freeze({
        kind: 'locale-bound',
        supplyingLocale: article.supplyingLocale,
        direction: article.direction,
      }),
      identity: Object.freeze({
        resourceId: `article:${article.entityId}`,
        representationId:
          article.supplyingLocale === 'ar-EG' ? 'article-ar' : 'article-en',
        revision: article.revision,
        correlationId: `${this.source.id}:${article.supplyingLocale}:${article.revision}`,
      }),
    });
    this.staged.set(context.transitionId, {
      report,
      article,
      ...(previousArticle === undefined ? {} : { previousArticle }),
      ...(previousReport === undefined ? {} : { previousReport }),
    });
    return report;
  }

  private commit(
    context: LocalizationParticipantContext,
    report: LocalizationParticipantCommitReport,
  ): void {
    const staged = this.staged.get(context.transitionId);
    if (staged?.article !== undefined) this.articleValue.set(staged.article);
    this.reportValue.set(report);
    if (staged !== undefined) {
      this.committed.set(context.transitionId, staged);
      while (this.committed.size > 8) {
        const oldest = this.committed.keys().next().value as number | undefined;
        if (oldest === undefined) break;
        this.committed.delete(oldest);
      }
    }
    this.staged.delete(context.transitionId);
    if (this.pendingTransitionValue() === context.transitionId) {
      this.pendingTransitionValue.set(undefined);
    }
    const article = this.articleValue();
    if (article !== undefined && staged?.article !== undefined) {
      this.transfer?.write(
        Object.freeze({
          profile: 'atlas-feature-article-transfer/1',
          article,
          report,
        }),
      );
    }
  }

  private rollback(
    context: LocalizationParticipantContext,
    _report: LocalizationParticipantCommitReport,
  ): void {
    const staged =
      this.committed.get(context.transitionId) ??
      this.staged.get(context.transitionId);
    this.articleValue.set(staged?.previousArticle);
    this.reportValue.set(staged?.previousReport);
    this.staged.delete(context.transitionId);
    this.committed.delete(context.transitionId);
    if (this.pendingTransitionValue() === context.transitionId) {
      this.pendingTransitionValue.set(undefined);
    }
  }

  private discard(context: LocalizationParticipantContext): void {
    this.staged.delete(context.transitionId);
    if (this.pendingTransitionValue() === context.transitionId) {
      this.pendingTransitionValue.set(undefined);
    }
  }
}

const DYNAMIC_CONTENT_SOURCE = new InjectionToken<FeatureArticleSource>(
  'atlas-feature-lab-dynamic-content-source',
);
const transferKey = makeStateKey<FeatureArticleTransfer>(
  '@atlas-feature-lab:dynamic-content/1',
);

export function provideDynamicContent(
  sourceFactory: () => FeatureArticleSource = () =>
    new MemoryFeatureArticleSource('source-a', 'Consumer source A'),
): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: DYNAMIC_CONTENT_SOURCE, useFactory: sourceFactory },
    {
      provide: DynamicContentStore,
      useFactory: () => {
        const source = inject(DYNAMIC_CONTENT_SOURCE);
        const state = inject(TransferState);
        const platformId = inject(PLATFORM_ID);
        const initial = state.get<FeatureArticleTransfer | null>(
          transferKey,
          null,
        );
        if (isPlatformBrowser(platformId) && initial !== null) {
          state.remove(transferKey);
        }
        return new DynamicContentStore(source, {
          ...(initial === null ? {} : { initial }),
          write: (value) => {
            if (isPlatformServer(platformId)) state.set(transferKey, value);
          },
        });
      },
    },
    provideEnvironmentInitializer(() => {
      const localization = inject(Localization);
      const store = inject(DynamicContentStore);
      store.attach(
        localization.registerParticipant(store.participant, {
          coordination: 'required',
          deadlineMilliseconds: 5_000,
        }),
      );
    }),
  ]);
}
