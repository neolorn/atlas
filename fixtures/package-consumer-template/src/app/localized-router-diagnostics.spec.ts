import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocationStrategy, PathLocationStrategy } from '@angular/common';
import { Injectable } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import * as angularRouter from '@angular/router';
import {
  TitleStrategy,
  UrlHandlingStrategy,
  withRouterConfig,
  withViewTransitions,
  type RouterFeatures,
  type UrlTree,
} from '@angular/router';
import {
  Localization,
  createHostLocalePolicy,
  createLocaleNeutralPolicy,
  withRouting,
  type LocaleUrlPolicy,
} from '@neolorn/atlas';
import {
  LocalizedTitleStrategy,
  provideLocalizedRouter,
} from '@neolorn/atlas/router';
import { provideLocalizationTesting } from '@neolorn/atlas/testing';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';
import { routeProjection } from '#i18n/routes';

import { atlasRuntimeExtensions } from './runtime-extensions';

/**
 * `ɵwithRouterResources` exists on 22.1.x and not on 22.0.x, so it is read off the namespace
 * rather than imported by name: a named import of a missing export does not compile, which took
 * the whole lower-bound row down rather than the one case that depends on it.
 *
 * Typed as returning `RouterFeatures` even though its own `RouterResourcesFeature` is not a
 * member of that union: it is structurally identical to `ViewTransitionsFeature`, which is what
 * makes it assignable and is the same fact the case below is about.
 */
const withRouterResources = (
  angularRouter as unknown as Record<string, unknown>
)['ɵwithRouterResources'] as (() => RouterFeatures) | undefined;
import { routes } from './app.routes';
import { routePolicy, appRouteProjection } from './localization.routes';

/**
 * What `provideLocalizedRouter` says when something of its own has been replaced.
 *
 * Both diagnostics are warnings and both are about silence. Angular provides
 * `ROUTER_CONFIGURATION` non-multi and `LocationStrategy` as an overridable root factory, so a
 * consumer replaces either of them by writing one line and nothing anywhere says so. Neither
 * replacement is refused: Atlas needs nothing from the router config beyond the one mode it
 * refuses outright, and a consumer's own `LocationStrategy` is an escape hatch rather than a
 * mistake.
 *
 * This file uses the application's real routes rather than a probe pair, so the route table itself
 * has nothing to report and any `[Atlas]` warning is the one under test.
 */

/**
 * Stands in for the kind of strategy an application writes for itself.
 *
 * `@Injectable()` is load-bearing and its absence is silent. `TitleStrategy` declares
 * `ɵprov = {factory: () => inject(DefaultTitleStrategy)}`, and an undecorated subclass inherits
 * that static through the prototype chain, so `useClass: ConsumerTitleStrategy` resolves the
 * *base* class's factory and hands back a `DefaultTitleStrategy`. Nothing throws; DI simply
 * provides a different class than the one named. Measured here: without the decorator this file's
 * assertion reported `DefaultTitleStrategy` for a provider that named this one.
 */
@Injectable()
class ConsumerTitleStrategy extends TitleStrategy {
  override updateTitle(): void {
    // Deliberately inert. This file asserts what Atlas reports about the token, not what the
    // replacement does with it: that is `title-strategy.spec.ts`, on the document.
  }
}

/** Angular's own default behaviour, under a consumer's name, and decorated for the same reason. */
@Injectable()
class ConsumerUrlHandling extends UrlHandlingStrategy {
  override shouldProcessUrl(): boolean {
    return true;
  }

  override extract(url: UrlTree): UrlTree {
    return url;
  }

  override merge(newUrlPart: UrlTree): UrlTree {
    return newUrlPart;
  }
}

/** The whole of the Atlas surface these assertions read: what it wrote to the console. */
interface WarnSpy {
  readonly mock: { readonly calls: readonly (readonly unknown[])[] };
}

function atlasWarnings(spy: WarnSpy): string[] {
  return spy.mock.calls
    .map((call): string => (typeof call[0] === 'string' ? call[0] : ''))
    .filter((message: string) => message.startsWith('[Atlas]'));
}

/**
 * `titleStrategy: 'omitted'` leaves the token unprovided rather than substituting something for it.
 * That is the configuration under test: Angular then resolves `TitleStrategy` through its own
 * root factory, exactly as it does for a consumer who never wrote the line.
 */
async function bootstrap(
  features: RouterFeatures[],
  extraProviders: unknown[] = [],
  titleStrategy: 'installed' | 'omitted' = 'installed',
  routing: {
    readonly policy?: LocaleUrlPolicy;
    readonly projection?: typeof appRouteProjection;
    readonly options?: Parameters<typeof provideLocalizedRouter>[1];
  } = {},
): Promise<void> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideLocalizedRouter(routes, routing.options ?? {}, ...features),
      ...(titleStrategy === 'installed'
        ? [{ provide: TitleStrategy, useClass: LocalizedTitleStrategy }]
        : []),
      provideLocalizationTesting(
        {
          configuration,
          catalogSet,
          catalogLoaders,
          recoveryPayload,
          extensions: atlasRuntimeExtensions,
          routeProjection,
        },
        withRouting({
          policy: routing.policy ?? routePolicy,
          projection: routing.projection ?? appRouteProjection,
        }),
      ),
      ...(extraProviders as never[]),
    ],
  });
  // Claiming anything from the environment injector runs its initializers, which is where both
  // diagnostics live: they report the DI outcome, so they cannot run before there is one.
  // Initialized as an application initializes it, so the teardown that follows is disposing a
  // context that started rather than one that never did.
  await TestBed.inject(Localization).initialize();
}

describe('provideLocalizedRouter diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says nothing when nothing of its own is replaced', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await bootstrap([]);
    expect(atlasWarnings(warn)).toEqual([]);
  });

  it('reports a router feature that replaces its configuration', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await bootstrap([withRouterConfig({ onSameUrlNavigation: 'reload' })]);
    expect(
      atlasWarnings(warn).filter((message) =>
        message.includes('ROUTER_CONFIGURATION'),
      ),
    ).toHaveLength(1);
  });

  /**
   * Mutation 2 of 5.1a, and the reason the check is a targeted comparison rather than a scan for
   * repeated kinds.
   *
   * `ɵkind` is not unique per feature in Angular itself: on 22.1.3 `withViewTransitions({})` and
   * `ɵwithRouterResources()` both answer 9. A "two features share a kind" scan would warn on this
   * pair, where nothing of Atlas's is replaced at all. Both features are constructed rather than
   * fabricated as objects carrying a `ɵkind`, because a fabricated pair would pass an
   * implementation that reads the real ones wrongly.
   *
   * **Version-specific, and it says so rather than being skipped quietly.** The collision is a
   * fact about a particular Angular build, not about Atlas: `ɵwithRouterResources` does not exist
   * on 22.0.4, so on that row there is no pair to collide and nothing for this case to assert.
   * Skipping alone would be the shape this whole file argues against, a check that stopped
   * running and still reported green, so the companion case below asserts the absence with a
   * control, and the two are mutually exclusive by construction.
   */
  it.skipIf(withRouterResources === undefined)(
    'stays silent on two Angular features that happen to share a kind',
    async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await bootstrap([withViewTransitions({}), withRouterResources!()]);
      expect(atlasWarnings(warn)).toEqual([]);
    },
  );

  /**
   * The other half, so exactly one of the two runs on every supported Angular row.
   *
   * This is the rule-12 half: it proves the case above was skipped because the symbol is genuinely
   * absent, not because the lookup was misspelled or the namespace import returned nothing. The
   * control is `withViewTransitions`, which must be present in the same namespace on every row.
   */
  it.skipIf(withRouterResources !== undefined)(
    'has no shared-kind pair to check on an Angular that lacks the second feature',
    () => {
      expect(
        typeof (angularRouter as Record<string, unknown>)[
          'withViewTransitions'
        ],
      ).toBe('function');
      expect(withRouterResources).toBeUndefined();
    },
  );

  /**
   * The direction that actually breaks localization, and the reason 5.1 ships an assertion instead
   * of a line the consumer has to write and read. Atlas registers its own `LocationStrategy`
   * before `provideRouter`, so this provider wins on ordinary ordering: the escape hatch works,
   * and it is not silent.
   */
  /**
   * The title half of the same idea, and the one configuration where the omission is expensive.
   *
   * Unlike `LocationStrategy`, a foreign `TitleStrategy` is only a defect when the routes give it
   * something to write, so the warning is conditioned on the route tree as well as on the token.
   * `app.routes.ts` declares one English title, on `second`, which is what makes this fire here.
   *
   * What the warning is *for* is asserted in `title-strategy.spec.ts`, on the document: this file
   * only proves that Atlas says something, and that it says it in the configuration where the
   * damage happens rather than in the one where it cannot.
   */
  it('warns when a route declares a title and the localized strategy is absent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await bootstrap([], [], 'omitted');
    const named = atlasWarnings(warn).filter((message) =>
      message.includes('TitleStrategy'),
    );
    expect(named).toHaveLength(1);
    expect(named[0]).toContain('DefaultTitleStrategy');
    expect(named[0]).toContain('LocalizedTitleStrategy');
  });

  /**
   * The second of the two mutations this pair covers, held open deliberately.
   *
   * A diagnostic asserted only in the configuration that installs the strategy is asserted in the
   * one configuration where it cannot fire, and is green for every consumer whose titles are being
   * overwritten. Both directions are here, and the silent one runs the same bootstrap as the case
   * above with one provider added, so it is the provider that makes the difference and not the
   * setup.
   */
  it('says nothing about the title once the strategy is installed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await bootstrap([], [], 'installed');
    expect(
      atlasWarnings(warn).filter((message) =>
        message.includes('TitleStrategy'),
      ),
    ).toEqual([]);
  });

  /**
   * A consumer's own strategy is warned about too, and that is deliberate rather than incidental.
   * `RouteMetadataTitleStrategy` overwrites a localized title exactly as `DefaultTitleStrategy`
   * does; the warning names what won so the reader can tell which of the two they are looking at.
   */
  it('names a consumer strategy that is not Atlas\u2019s', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await bootstrap(
      [],
      [{ provide: TitleStrategy, useClass: ConsumerTitleStrategy }],
      'omitted',
    );
    const named = atlasWarnings(warn).filter((message) =>
      message.includes('ConsumerTitleStrategy'),
    );
    expect(named).toHaveLength(1);
  });

  it('names the strategy that won when it is not the localized one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await bootstrap(
      [],
      [{ provide: LocationStrategy, useClass: PathLocationStrategy }],
    );
    const named = atlasWarnings(warn).filter((message) =>
      message.includes('PathLocationStrategy'),
    );
    expect(named).toHaveLength(1);
    expect(named[0]).toContain('LocationStrategy');
  });

  /**
   * The other door, and it is worth its own case for the reason the source gives it its own
   * sentence: this one fails invisibly.
   *
   * A foreign `LocationStrategy` breaks every localized address at once, so the application is
   * obviously broken and somebody looks. A foreign `UrlHandlingStrategy` breaks nothing a browser
   * does: every link, every reload, every shared address still works, because the
   * `LocationStrategy` is still delocalizing those. Only a programmatic navigation to a prefixed
   * address is affected, and what it does is render the not-found page. An application can ship
   * that way and read as correct.
   *
   * `ConsumerUrlHandling` is a real subclass rather than a substitute for one, so the DI outcome
   * this reads is the one a consumer's own strategy produces. It has to be decorated: an
   * undecorated subclass of an injectable whose provider declares a `factory` inherits that static
   * through the prototype chain, and `useClass` then resolves the base class's factory and hands
   * back something else entirely. The defect this file already records against
   * `ConsumerTitleStrategy`.
   */
  it('names a UrlHandlingStrategy that is not Atlas\u2019s', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await bootstrap(
      [],
      [{ provide: UrlHandlingStrategy, useClass: ConsumerUrlHandling }],
    );
    const named = atlasWarnings(warn).filter((message) =>
      message.includes('ConsumerUrlHandling'),
    );
    expect(named).toHaveLength(1);
    expect(named[0]).toContain('UrlHandlingStrategy');
    // What it costs, said in the message, because the class name alone does not tell a reader why
    // they should care about a token they have never heard of.
    expect(named[0]).toContain('not delocalized');
  });

  /**
   * And the read is a read, not a wiring assumption.
   *
   * `says nothing when nothing of its own is replaced` above covers this token along with every
   * other, which is what makes the assertion here about the *token* rather than about the absence
   * of output: Atlas installed its own and the injector confirms it, in the same bootstrap the
   * warning case uses minus one provider.
   */
  it('finds its own UrlHandlingStrategy in the injector when nothing replaced it', async () => {
    await bootstrap([]);
    expect(TestBed.inject(UrlHandlingStrategy).constructor.name).toBe(
      'LocalizedUrlHandlingStrategy',
    );
  });
});

/**
 * Served, or refused by name, and never warned about.
 *
 * Everything above is a warning, because everything above is a choice a consumer is entitled to
 * make. A policy kind is not that: three exported, documented kinds accepted by name and served
 * partly, behind an `unlocalizable-policy` warning that a production build never prints and nobody
 * reads, is an application that half works. All three are served; what these cases pin is that the
 * decision is made rather than defaulted, so a kind Atlas has not decided about cannot start.
 */
const NEUTRAL = createLocaleNeutralPolicy({
  defaultLocale: 'en-US',
  locales: ['en-US', 'ar-EG', 'en-Arab-XB'],
  localeNeutralRoots: ['assets'],
  xDefaultPath: '/',
});

const HOST = createHostLocalePolicy({
  defaultLocale: 'en-US',
  origins: {
    'en-US': 'https://atlas.example',
    'ar-EG': 'https://ar.atlas.example',
    'en-Arab-XB': 'https://xb.atlas.example',
  },
  localeNeutralRoots: ['assets'],
  xDefaultUrl: 'https://atlas.example',
});

/** Which of the host policy's origins this build answers at, which a host policy must be told. */
const AT_EN = { origin: 'https://atlas.example' } as const;

describe('provideLocalizedRouter decides every policy kind by name', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The served side, and the half with something to warn about.
   *
   * `localizedRouteTable` gives a one-address-space policy no locale branches, which is the correct
   * table rather than a reduced one, so reporting it as an `unlocalizable-policy` problem for
   * `provideLocalizedRouter` to print and carry on from warns about a correct result. Starting
   * silently is the assertion.
   */
  it('serves a locale-neutral policy, and says nothing about it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await bootstrap([], [], 'installed', { policy: NEUTRAL });
    expect(TestBed.inject(UrlHandlingStrategy).constructor.name).toBe(
      'LocalizedUrlHandlingStrategy',
    );
    expect(atlasWarnings(warn)).toEqual([]);
  });

  it('serves a locale-host policy, and says nothing about it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await bootstrap([], [], 'installed', { policy: HOST, options: AT_EN });
    expect(TestBed.inject(LocationStrategy).constructor.name).toBe(
      'LocalizedLocationStrategy',
    );
    expect(atlasWarnings(warn)).toEqual([]);
  });

  /**
   * The origin a host policy answers at, and the mismatch that produced a build which looked fine.
   *
   * Measured on both paths: naming the configured origin in the policy turns a failing prerender
   * into a working one, and changing only its scheme turns it back into two `malformed`
   * resolutions, no per-route HTML, `Prerendered 2 static routes` on the console and exit `0`.
   * These cases are that measurement made unrepresentable.
   */
  it('serves a host policy at a non-default origin the policy names', async () => {
    await bootstrap([], [], 'installed', {
      policy: HOST,
      options: { origin: 'https://ar.atlas.example' },
    });
    expect(TestBed.inject(LocationStrategy).constructor.name).toBe(
      'LocalizedLocationStrategy',
    );
  });

  it('refuses a host policy whose origins do not name the configured origin', async () => {
    await expect(
      bootstrap([], [], 'installed', {
        policy: HOST,
        options: { origin: 'https://elsewhere.example' },
      }),
    ).rejects.toThrow(/does not name/u);
  });

  /**
   * The half that is easiest to skim past, and the one this fixture got wrong by hand.
   * `https://atlas.example` and `http://atlas.example` are two origins, and the message says so.
   */
  it('refuses a host policy whose configured origin differs only in scheme', async () => {
    await expect(
      bootstrap([], [], 'installed', {
        policy: HOST,
        options: { origin: 'http://atlas.example' },
      }),
    ).rejects.toThrow(/scheme is part of an origin/u);
  });

  it('refuses a host policy configured with no origin at all', async () => {
    await expect(
      bootstrap([], [], 'installed', { policy: HOST }),
    ).rejects.toThrow(/needs to be told which origin this build answers at/u);
  });

  /**
   * Trailing slash and default port, which are not mismatches. Compared as origins rather than as
   * strings, so a consumer who writes the value the way a browser prints it is not refused for it.
   */
  it('accepts the configured origin written with a trailing slash', async () => {
    await bootstrap([], [], 'installed', {
      policy: HOST,
      options: { origin: 'https://atlas.example/' },
    });
    expect(TestBed.inject(LocationStrategy).constructor.name).toBe(
      'LocalizedLocationStrategy',
    );
  });

  /** The check is the host policy's, and no other kind acquires it. */
  it('leaves a path-prefix policy alone whatever origin it was given', async () => {
    await bootstrap([], [], 'installed', {
      options: { origin: 'https://nothing-in-any-policy.example' },
    });
    expect(TestBed.inject(LocationStrategy).constructor.name).toBe(
      'LocalizedLocationStrategy',
    );
  });

  /**
   * A kind Atlas has not decided about does not start. What refuses it is not the gate.
   *
   * The gate's last arm assigns the narrowed policy to `never`, so a fourth member added to
   * `LocaleUrlPolicy` is a type error there, which is the guarantee that matters and is not
   * something a test can exercise. The runtime arm behind it was written for this case and
   * **measured unreachable**: a policy object carrying an unknown `kind` dies in
   * `builtLocalePolicy` before any router provider runs (`builtLocales`, reading a locale list the
   * unknown kind does not have). Making the object structurally complete did not help, because
   * what is missing is not a field, it is the branch.
   *
   * So this asserts the property rather than the message: **it does not boot**. Naming the thrower
   * would pin an upstream implementation detail, and asserting the gate's own text would assert
   * something that never runs.
   */
  it('does not start on a policy kind it has not decided about', async () => {
    const unknown = {
      ...NEUTRAL,
      ...HOST,
      kind: 'locale-query',
    } as unknown as LocaleUrlPolicy;
    await expect(
      bootstrap([], [], 'installed', { policy: unknown }),
    ).rejects.toThrow();
  });
});
