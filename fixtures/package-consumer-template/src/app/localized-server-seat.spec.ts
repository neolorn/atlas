import { describe, expect, it } from 'vitest';

import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, RouterOutlet, TitleStrategy } from '@angular/router';
import { Localization, withRouting } from '@neolorn/atlas';
import { pageGone } from '@neolorn/atlas/core';
import {
  declarePageOutcome,
  type LocaleRenderer,
  type LocaleRequestOutcome,
} from '@neolorn/atlas/http';
import {
  LocalizedTitleStrategy,
  provideLocalizedRouter,
} from '@neolorn/atlas/router';
import {
  createLocalizedServerSeat,
  provideLocalizationTesting,
} from '@neolorn/atlas/testing';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { messages } from '#i18n/shell';
import { recoveryPayload } from '#i18n/recovery-payload';
import { routeProjection } from '#i18n/routes';

import { routes } from './app.routes';
import { atlasRuntimeExtensions } from './runtime-extensions';
import { provideDynamicContent } from './dynamic-content';
import {
  routePolicy,
  appRouteProjection,
  SITE_ORIGIN,
} from './localization.routes';

/**
 * The seat a consumer asserts a response from, exercised against the built packages.
 *
 * Section 12 of `specs/06-runtime-and-angular.spec.md` puts it in `@neolorn/atlas/testing` and
 * requires it to answer through the request handler a deployment uses, with no socket, no built
 * bundle and no browser. This file is the half the package's own unit suite cannot reach: whether
 * `@neolorn/atlas/testing` resolves `@neolorn/atlas/http` once it is installed as a package, and
 * whether the head it reads is the head Atlas actually writes rather than one written here.
 *
 * The renderer below is the component seat: it commits the locale the handler resolved, navigates
 * to the address it resolved, and hands back the document. That is what makes the canonical link
 * and the `hreflang` cluster in the assertions Atlas's own output.
 */

const CACHE = { successMaxAge: 300, permanentRedirectMaxAge: 86_400 } as const;

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

@Component({
  standalone: true,
  imports: [RouterOutlet],
  template: `<router-outlet />`,
})
class RootHost {}

async function configure(): Promise<Router> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    providers: [
      provideLocalizedRouter(routes, {
        origin: SITE_ORIGIN,
        outcomeDocuments: OUTCOME_DOCUMENTS,
        documentMetadata: {
          'route:second': {
            title: messages.document.second.title,
            description: messages.document.second.description,
          },
        },
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

/** The same interleaving `declared-page-outcome.spec.ts` waits on, for the same reason. */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    TestBed.tick();
    for (let hop = 0; hop < 3; hop += 1) await Promise.resolve();
  }
  TestBed.tick();
}

/** Renders the address the handler resolved, in the locale it resolved, through the component seat. */
async function renderThroughTestBed({
  request,
  locale,
}: LocaleRequestOutcome): Promise<Response> {
  const router = await configure();
  await TestBed.inject(Localization).changeLocale(locale);
  await router.navigateByUrl(new URL(request.url).pathname);
  await settle();
  return new Response(`<!doctype html>${document.documentElement.outerHTML}`, {
    headers: { 'content-type': 'text/html' },
  });
}

const seat = (render: LocaleRenderer = renderThroughTestBed) =>
  createLocalizedServerSeat({
    policy: routePolicy,
    projection: appRouteProjection,
    configuration,
    cache: CACHE,
    cookie: false,
    origin: SITE_ORIGIN,
    render,
  });

describe('an address answered through the server seat', () => {
  it('answers a localized address with its status, language and cacheability', async () => {
    const answered = await seat().request('/en-us/second');

    expect(answered.status).toBe(200);
    expect(answered.headers.get('content-language')).toBe('en-US');
    expect(answered.headers.get('cache-control')).toBe(
      'public, max-age=300, must-revalidate',
    );
  });

  it('hands back the head Atlas wrote, rather than one the test wrote', async () => {
    const answered = await seat().request('/ar-eg/second');

    expect(answered.head.lang).toBe('ar-EG');
    expect(answered.head.dir).toBe('rtl');
    expect(answered.head.title).toBe('العنوان الثاني');
    expect(answered.head.canonical).toBe(`${SITE_ORIGIN}/ar-eg/second`);
    // One canonical, and a reciprocal cluster beside it. Both are what a consumer building its own
    // harness was checking by parsing HTML off a socket.
    expect(
      answered.head.links.filter((link) => link.rel === 'canonical'),
    ).toHaveLength(1);
    expect(answered.head.alternates.map((link) => link.hreflang)).toContain(
      'en-US',
    );
  });

  it('sends an entry address to the language that was asked for', async () => {
    const answered = await seat().request('/second', {
      headers: { 'accept-language': 'ar-EG,en;q=0.8' },
    });

    expect(answered.status).toBe(307);
    expect(answered.headers.get('location')).toBe('/ar-eg/second');
    expect(answered.resolution.status).toBe('redirect');
  });

  it('writes a head for an address that reached no route', async () => {
    // The outcome document, read back off the response rather than off the test's own DOM. Without
    // one the head here is whatever the previous page left in it.
    const answered = await seat().request('/en-us/no-such-page');

    expect(answered.status).toBe(404);
    expect(answered.head.title).toBe('Page not found');
    expect(answered.head.canonical).toBeUndefined();
  });

  it('carries an outcome the renderer declared, and says that it carried', async () => {
    const answered = await seat(() => declarePageOutcome(pageGone())).request(
      '/en-us/second',
    );

    expect(answered.status).toBe(410);
    expect(answered.pageOutcome?.declared.outcome).toBe('gone');
    expect(answered.pageOutcome?.carried).toBe(true);
    expect(answered.headers.get('cache-control')).toBe('private, no-store');
  });
});
