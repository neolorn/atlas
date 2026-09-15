import { describe, expect, it } from 'vitest';

import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, RouterOutlet, TitleStrategy } from '@angular/router';
import { Localization, withRouting } from '@neolorn/atlas';
import {
  LocalizedTitleStrategy,
  provideLocalizedRouter,
} from '@neolorn/atlas/router';
import { provideLocalizationTesting } from '@neolorn/atlas/testing';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { messages } from '#i18n/shell';
import { recoveryPayload } from '#i18n/recovery-payload';
import { routeProjection } from '#i18n/routes';

import { routes } from './app.routes';
import { atlasRuntimeExtensions } from './runtime-extensions';
import { provideDynamicContent } from './dynamic-content';
import { routePolicy, appRouteProjection } from './localization.routes';

/**
 * A page that resolved and turned out not to be there, and the head that follows from it.
 *
 * Section 12 of `specs/07-routing-rendering-and-seo.spec.md` derives what the address implies from
 * the outcome in force rather than carrying it over, so a page that has declared its entity absent
 * stops claiming a canonical address and stops offering alternates, and section 5 forbids
 * synthesizing a response for it on a client navigation. Both halves are here because either alone
 * still publishes a claim the page contradicts.
 *
 * The other half of the declaration, the status it produces on a server, is in the package's own
 * `declared-page-outcome.test.ts`: there is no response to read from a client navigation, which is
 * the point of the last case in this file.
 */

const ARABIC = 'ar-EG';
const ORIGIN = 'https://atlas.example';

/**
 * A host with an outlet, because the declaration comes from the route's own component.
 *
 * Without a rendered outlet nothing declares and every assertion below reads the head Atlas built
 * from the address alone, which is the head this file exists to say is not enough.
 */
@Component({
  standalone: true,
  imports: [RouterOutlet],
  template: `<router-outlet />`,
})
class RootHost {}

const OUTCOME_DOCUMENTS = {
  'not-found': {
    title: messages.document.notFound.title,
    description: messages.document.notFound.description,
  },
  gone: {
    title: messages.document.gone.title,
    description: messages.document.gone.description,
  },
  'unsupported-locale': {
    title: messages.document.unsupportedLocale.title,
    description: messages.document.unsupportedLocale.description,
  },
} as const;

async function configure(): Promise<Router> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    providers: [
      provideLocalizedRouter(routes, {
        origin: ORIGIN,
        outcomeDocuments: OUTCOME_DOCUMENTS,
        documentMetadata: {
          topic: {
            title: messages.document.topic.title,
            description: messages.document.topic.description,
          },
        },
        document: (context, localization) =>
          context.pageOutcome?.outcome === 'absent'
            ? {
                title: localization.text(messages.document.topicAbsent.title),
                description: localization.text(
                  messages.document.topicAbsent.description,
                ),
              }
            : {},
      }),
      provideLocalizationTesting(
        {
          configuration,
          catalogSet,
          catalogLoaders,
          recoveryPayload,
          extensions: atlasRuntimeExtensions,
          routeProjection,
        },
        withRouting({ policy: routePolicy, projection: appRouteProjection }),
      ),
      { provide: TitleStrategy, useClass: LocalizedTitleStrategy },
      provideDynamicContent(),
    ],
  }).compileComponents();
  await TestBed.inject(Localization).initialize();
  TestBed.createComponent(RootHost);
  return TestBed.inject(Router);
}

/** The same interleaving `localized-route-parameters.spec.ts` waits on, for the same reason. */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    TestBed.tick();
    for (let hop = 0; hop < 3; hop += 1) await Promise.resolve();
  }
  TestBed.tick();
}

const canonical = (): string | null =>
  document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null;

const alternates = (): number =>
  document.querySelectorAll('link[rel="alternate"]').length;

const robots = (): string | null =>
  document.querySelector('meta[name="robots"]')?.getAttribute('content') ??
  null;

const description = (): string | null =>
  document.querySelector('meta[name="description"]')?.getAttribute('content') ??
  null;

describe('a route whose entity turned out to be absent', () => {
  it('publishes the head of a page that is there before anything says otherwise', async () => {
    // The control, measured rather than argued. A filed topic is an ordinary indexable page, so
    // every assertion below is distinguishable from one that simply found no head at all.
    const router = await configure();
    await router.navigateByUrl('/topics/atlas-handbook');
    await settle();

    expect(document.title).toBe('Topic');
    expect(canonical()).toBe(`${ORIGIN}/en-us/topics/atlas-handbook`);
    expect(alternates()).toBeGreaterThan(0);
    expect(robots()).toBeNull();
  });

  it('withdraws the canonical address and the alternates when the page declares it is not there', async () => {
    const router = await configure();
    await router.navigateByUrl('/topics/nothing-filed-here');
    await settle();

    // An alternate link states that the same page exists in another language. Left standing on a
    // page that is not there it is a claim the response contradicts, in every other language at
    // once.
    expect(canonical()).toBeNull();
    expect(alternates()).toBe(0);
    expect(robots()).toBe('noindex');
  });

  it('lets the application say what a missing page is called', async () => {
    const router = await configure();
    await router.navigateByUrl('/topics/nothing-filed-here');
    await settle();

    expect(document.title).toBe('Topic not found');
    expect(description()).toBe('No topic is filed under this address.');
  });

  it('does not carry one page’s declaration onto the next', async () => {
    const router = await configure();
    await router.navigateByUrl('/topics/nothing-filed-here');
    await settle();
    expect(canonical()).toBeNull();

    // The trap the navigation stamp exists to prevent: the page after a missing one is an ordinary
    // page, and a declaration held anywhere but on the navigation that made it would answer for
    // both.
    await router.navigateByUrl('/topics/atlas-handbook');
    await settle();
    expect(canonical()).toBe(`${ORIGIN}/en-us/topics/atlas-handbook`);
    expect(robots()).toBeNull();
    expect(document.title).toBe('Topic');
  });

  it('keeps the page on screen rather than inventing a response for it', async () => {
    const router = await configure();
    await router.navigateByUrl('/topics/nothing-filed-here');
    await settle();

    // A client navigation has no response to reach, and section 5 forbids synthesizing one. The
    // route stays activated and the address bar stays where the reader put it; what the
    // declaration governs here is the document.
    expect(router.url).toContain('/topics/nothing-filed-here');
    expect(document.querySelector('[data-route-view="topic"]')).not.toBeNull();
  });
});

describe('a response that reached no route at all', () => {
  it('writes the head of an address this application does not serve', async () => {
    const router = await configure();
    await router.navigateByUrl('/topics/atlas-handbook');
    await settle();
    expect(document.title).toBe('Topic');

    await router.navigateByUrl('/nowhere-at-all');
    await settle();

    // Without an outcome document this head is the previous page's, in full: its title, its
    // description, and a canonical link saying this address is that page.
    expect(document.title).toBe('Page not found');
    expect(description()).toBe(
      'This address does not name a page in this application.',
    );
    expect(canonical()).toBeNull();
  });

  it('writes it in the locale the address was asked for', async () => {
    const router = await configure();
    await router.navigateByUrl('/ar-eg/nowhere-at-all');
    await settle();

    expect(document.title).toBe('الصفحة غير موجودة');
  });

  it('moves it when the reader changes language', async () => {
    const router = await configure();
    await router.navigateByUrl('/nowhere-at-all');
    await settle();
    expect(document.title).toBe('Page not found');

    // A locale change is not a navigation, and there is no route context to rebuild from here.
    // Without the outcome class being held, the head of a missing page stays in the language the
    // reader has just left.
    await TestBed.inject(Localization).changeLocale(ARABIC);
    await settle();
    expect(document.title).toBe('الصفحة غير موجودة');
  });

  it('writes the head of an address declared permanently removed', async () => {
    const router = await configure();
    await router.navigateByUrl('/removed');
    await settle();

    expect(document.title).toBe('Page removed');
    expect(canonical()).toBeNull();
  });
});
