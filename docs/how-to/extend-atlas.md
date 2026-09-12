# How to extend Atlas

Two extension points, for the cases where the coordination Atlas owns has to include work Atlas
cannot see.

## Before you begin

Two checks come first.

A participant rather than an extension: something that has to reload when the locale changes is a
participant, and that is the smaller thing.

A message rather than either: something that has to read differently in each language belongs in a
catalog with a placeholder, which is [How to write a message](write-messages.md) and takes no code.

## Bring your own work into a locale change

A locale change moves the whole application at once, and that includes things Atlas does not know
about: a content store, a search index, a client for a system that returns localized text.

A participant is that store, with hooks the transition calls. `prepare` is asked for the arriving
locale and stages what it loaded. `commit` swaps the staged payload in, once every other participant has prepared too.
`rollback` and `discard` put it back when the transition is undone or superseded.

Register it in an environment initializer, so the first load runs it along with everything else:

```ts src/app/articles.ts
import {
  inject,
  makeEnvironmentProviders,
  provideEnvironmentInitializer,
  signal,
  type EnvironmentProviders,
  type Signal,
} from '@angular/core';
import { Localization, directionForLocale } from '@neolorn/atlas';
import type {
  LocalizationParticipant,
  LocalizationParticipantCommitReport,
  LocalizationParticipantContext,
} from '@neolorn/atlas';

export interface Article {
  readonly title: string;
  readonly supplyingLocale: string;
}

// Content this application owns. Atlas never sees it, so none of it comes out of a catalog.
const TITLES: Readonly<Record<string, string>> = {
  'en-US': 'The Atlas handbook',
  'ar-EG': 'دليل أطلس',
};

const SOURCE_LOCALE = 'en-US';

export class ArticleStore {
  private readonly committed = signal<Article | undefined>(undefined);
  private readonly staged = new Map<number, Article>();

  readonly article: Signal<Article | undefined> = this.committed.asReadonly();

  readonly participant: LocalizationParticipant = Object.freeze({
    id: 'article',
    prepare: (context: LocalizationParticipantContext) => this.prepare(context),
    commit: (context: LocalizationParticipantContext) => this.commit(context),
    discard: (context: LocalizationParticipantContext) => {
      this.staged.delete(context.transitionId);
    },
  });

  private async prepare(
    context: LocalizationParticipantContext,
  ): Promise<LocalizationParticipantCommitReport> {
    // A store keyed by locale is asked for every locale the build has, including one nobody has
    // written content for yet. Answering with the source locale keeps the page openable, and
    // `supplyingLocale` is what lets the page mark the region as being in another language.
    const supplying =
      context.targetLocale in TITLES ? context.targetLocale : SOURCE_LOCALE;
    const title = await load(supplying, context.signal);

    this.staged.set(context.transitionId, {
      title,
      supplyingLocale: supplying,
    });
    return {
      status: 'ready',
      representation: {
        kind: 'locale-bound',
        supplyingLocale: supplying,
        direction: directionForLocale(supplying),
      },
      identity: { resourceId: 'article:handbook' },
    };
  }

  private commit(context: LocalizationParticipantContext): void {
    const staged = this.staged.get(context.transitionId);
    if (staged !== undefined) this.committed.set(staged);
    this.staged.delete(context.transitionId);
  }
}

/** Stands in for whatever this application reads its content out of. */
function load(locale: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return Promise.resolve(TITLES[locale] ?? '');
}

export function provideArticles(): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: ArticleStore, useFactory: () => new ArticleStore() },
    provideEnvironmentInitializer(() => {
      const localization = inject(Localization);
      const store = inject(ArticleStore);
      localization.registerParticipant(store.participant, {
        coordination: 'required',
      });
    }),
  ]);
}
```

`prepare` may return a promise, and the transition waits for it. A participant that rejects fails the
switch, which leaves the page in the locale it was already in rather than half moved.

A participant registered later, from a component that has just been created, joins from the next
transition onward. The initial load has already run by then.

```ts src/app/articles.spec.ts
import { afterEach, describe, expect, it } from 'vitest';

import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Localization, withRecoveryMessage } from '@neolorn/atlas';
import {
  provideLocalizationTesting,
  resetLocalizationTestEnvironment,
} from '@neolorn/atlas/testing';
import { localizationSetup } from '#i18n';
import { messages } from '#i18n/shell';

import { ArticleStore, provideArticles } from './articles';

afterEach(resetLocalizationTestEnvironment);

async function setup() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideLocalizationTesting(
        localizationSetup,
        withRecoveryMessage({ message: messages.recoveryMessage }),
      ),
      provideArticles(),
    ],
  });

  const localization = TestBed.inject(Localization);
  await localization.initialize();

  return { localization, store: TestBed.inject(ArticleStore) };
}

describe('the article store', () => {
  it('is prepared before the first render', async () => {
    const { store } = await setup();

    expect(store.article()?.supplyingLocale).toBe('en-US');
  });

  it('moves with the locale', async () => {
    const { localization, store } = await setup();

    await localization.changeLocale('ar-EG');

    expect(store.article()?.supplyingLocale).toBe('ar-EG');
    expect(store.article()?.title).toBe('دليل أطلس');
  });

  it('reports what it is holding, by locale and by direction', async () => {
    const { localization } = await setup();
    await localization.changeLocale('ar-EG');

    const report = localization
      .participants()
      .find((state) => state.participantId === 'article')?.current?.report;

    expect(report?.status).toBe('ready');
    expect(report?.status === 'ready' && report.representation).toEqual({
      kind: 'locale-bound',
      supplyingLocale: 'ar-EG',
      direction: 'rtl',
    });
  });
});
```

`registerParticipant` is a method rather than a feature you compose, because participants come and go
with the components that own them. It returns a registration carrying `retry()` and `unregister()`.

`participants()` on the facade reports what each one is doing, which is what to render when a switch
is slow enough to show progress for.

## Teach Atlas about a value type

`withExtensions` is for a value type your domain has and `Intl` does not: a formatting or parsing
adapter Atlas calls the way it calls its own.

```text
export const atlasRuntimeExtensions = defineRuntimeExtensions([
  {
    descriptor: {
      profile: EXTENSION_DESCRIPTOR_PROFILE,
      id: 'acme.part-number',
      fingerprint: 'sha256-...',
      kind: 'formatting-adapter',
      inputType: 'acme.PartNumber',
      result: 'text',
      maximumOutputLength: 64,
    },
    format: ({ value, locale }) => ({ text: spellPartNumber(value, locale) }),
  },
]);
```

`defineRuntimeExtensions` declares the bindings and `withExtensions` installs them.
`atlasExtensionDescriptor` on the toolkit side tells the compiler about the same set, so what your
code registers and what your build knows about are one declaration.

Five contracts are extensible, and each is validated at build: message functions, identifier
segments, rich slot kinds, formatting adapters, and parsing adapters.

## Limits on an extension

An extension supplies behavior for a value. It does not change what a message is, what a catalog can
contain, or what a translated string is allowed to become on the page.

An extension is registered rather than discovered. Nothing scans for extensions, nothing loads one
from configuration, and no name resolves to code at runtime.

## Related

- [About how a locale switch is a transaction](../explanation/about-locale-switching.md)
- [About the trust model for translated content](../explanation/about-trusted-content.md)
- [Entry points](../reference/entry-points.md)
