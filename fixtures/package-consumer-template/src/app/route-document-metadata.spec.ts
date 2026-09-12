import { afterEach, describe, expect, it, vi } from 'vitest';

import { TestBed } from '@angular/core/testing';
import { Router, TitleStrategy } from '@angular/router';
import { Localization, withRouting } from '@neolorn/atlas';
import {
  LocalizedTitleStrategy,
  provideLocalizedRouter,
  type LocalizedRouterOptions,
} from '@neolorn/atlas/router';
import { provideLocalizationTesting } from '@neolorn/atlas/testing';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';
import { routeProjection } from '#i18n/routes';
import { messages } from '#i18n/shell';

import { routes } from './app.routes';
import { atlasRuntimeExtensions } from './runtime-extensions';
import { routePolicy, appRouteProjection } from './localization.routes';

/**
 * Does a route's document metadata come from the catalog for the locale that is active?
 *
 * The defect this replaced was not a missing lookup. It was a conditional chain on
 * `context.resolution.routeId` inside the `document` callback, whose last branch answered for every
 * route the chain did not name, so most of the application's pages claimed to be the home page,
 * in whichever language was active, and nothing anywhere reported it. The chain compiled, ran, and
 * returned a real localized string every time.
 *
 * **Two routes, not one.** With a single route under test, "each route's own metadata" and "one
 * title for the whole application" produce identical output, and the assertion is green for the
 * defect it was written against. Every case below reads at least two routes.
 */

const ARABIC = 'ar-EG';

async function configure(
  documentMetadata: Record<string, unknown> | undefined,
  document?: LocalizedRouterOptions['document'],
): Promise<Router> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    providers: [
      provideLocalizedRouter(routes, {
        origin: 'https://atlas.example',
        ...(documentMetadata === undefined
          ? {}
          : { documentMetadata: documentMetadata as never }),
        ...(document === undefined ? {} : { document }),
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
      // The application's own configuration. Without it Angular's `DefaultTitleStrategy` writes the
      // English `title` that `app.routes.ts` declares on `second` over everything asserted here,
      // which is 8.2's defect, and is not what this file is measuring.
      { provide: TitleStrategy, useClass: LocalizedTitleStrategy },
    ],
  }).compileComponents();
  await TestBed.inject(Localization).initialize();
  return TestBed.inject(Router);
}

/** The declaration this application ships, restated here only so a case can vary one entry of it. */
const DECLARED = {
  'route:_index': {
    title: messages.document.title,
    description: messages.document.description,
  },
  'route:second': {
    title: messages.document.second.title,
    description: messages.document.second.description,
  },
} as const;

const description = (): string | null =>
  document.querySelector('meta[name="description"]')?.getAttribute('content') ??
  null;

describe('a route document declared by route id', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders each route’s own title and description, in the active locale', async () => {
    const router = await configure(DECLARED);
    const localization = TestBed.inject(Localization);
    await localization.changeLocale(ARABIC);

    await router.navigateByUrl('/');
    expect(document.title).toBe('مختبر ميزات Atlas');
    expect(description()).toBe('مختبر وقت تشغيل الترجمة في Atlas.');

    await router.navigateByUrl('/second');
    // Distinct from the home title, and distinct from `route.second`: the label this route
    // renders inside the page. Both distinctions are deliberate: sharing either string would let a
    // wrong lookup pass.
    expect(document.title).toBe('العنوان الثاني');
    expect(description()).toBe(
      'عنوان ثانٍ، لإثبات أن بيانات كل صفحة خاصة بها.',
    );
  });

  it('follows the locale rather than the navigation', async () => {
    // The catalog is chosen when the document is projected, not when the map is written. Asserted
    // in both directions on one route, because a lookup hardcoded to the source locale answers
    // English correctly and is the whole defect.
    const router = await configure(DECLARED);
    await router.navigateByUrl('/second');
    expect(document.title).toBe('Second address');

    await TestBed.inject(Localization).changeLocale(ARABIC);
    // The re-projection runs in an effect, so it lands on the next change detection rather than
    // inside `changeLocale`. A zoneless application schedules that itself; a zoneless TestBed has
    // to be told, and without this the assertion reads the title from before the switch.
    TestBed.tick();
    expect(document.title).toBe('العنوان الثاني');
  });

  it('lets the dynamic callback override one field and keep the rest', async () => {
    // The two halves compose rather than replace. A route whose title is fetched keeps the
    // description its catalog declares, and a callback that returned a whole projection would
    // silently drop it.
    const router = await configure(DECLARED, () => ({
      title: 'From the store',
    }));
    await router.navigateByUrl('/second');
    expect(document.title).toBe('From the store');
    expect(description()).toBe(
      "A second address, to prove one route's metadata is its own.",
    );
  });

  it('reports a route that reached a visitor with no title', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // `/second` declared, `/items/42` not, and no callback to cover it.
    const router = await configure({
      'route:second': DECLARED['route:second'],
    });
    await router.navigateByUrl('/second');
    await router.navigateByUrl('/items/42');

    const untitled = warn.mock.calls
      .map((call) => (typeof call[0] === 'string' ? call[0] : ''))
      .filter((message) => message.includes('no document title'));
    expect(untitled).toHaveLength(1);
    expect(untitled[0]).toContain('"item"');
    // And the declared one is not reported, which is what makes the case above a finding rather
    // than a warning that fires for everything.
    expect(untitled[0]).not.toContain('route:second');
  });

  it('reports a declaration naming a route that does not exist', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await configure({
      ...DECLARED,
      'route:renamed-away': DECLARED['route:second'],
    });
    const named = warn.mock.calls
      .map((call) => (typeof call[0] === 'string' ? call[0] : ''))
      .filter((message) => message.includes('documentMetadata'));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain('"route:renamed-away"');
    // The keys that do name routes are not reported, so this cannot pass by reporting everything.
    expect(named[0]).not.toContain('names "route:second"');
  });
});
