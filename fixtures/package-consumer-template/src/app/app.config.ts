import {
  type ApplicationConfig,
  inject,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import {
  provideClientHydration,
  withEventReplay,
} from '@angular/platform-browser';
import { TitleStrategy, withInMemoryScrolling } from '@angular/router';
import {
  cookieStore,
  withExtensions,
  withFormattingContext,
  withLocalizationClock,
  systemClock,
  withPersistence,
  withRecoveryMessage,
  withRouting,
} from '@neolorn/atlas';
import {
  LocalizedTitleStrategy,
  provideLocalizedRouter,
} from '@neolorn/atlas/router';
import { provideLocalization } from '#i18n';
import { providerId, scopeId } from '#i18n/shell';
import { messages } from '#i18n/shell';
import {
  providerId as lazyProviderId,
  scopeId as lazyScopeId,
} from '#i18n/lazy';

import { routes } from './app.routes';
import { localeCookie } from './locale-cookie';
import { atlasRuntimeExtensions } from './runtime-extensions';
import { DynamicContentStore, provideDynamicContent } from './dynamic-content';
import {
  routePolicy,
  appRouteProjection,
  SITE_ORIGIN,
} from './localization.routes';

/**
 * The formatting context this application declares.
 *
 * Exported so a test can assert the values the application actually ships rather than a copy of
 * them. `numberingSystem: 'latn'` is the load-bearing one: `ar-EG` resolves to `arab` on its own,
 * so this line is the difference between Latin and Arabic-Indic digits on every localized surface,
 * and until `app-formatting-context.spec.ts` existed nothing asserted that it arrived. Only the
 * browser harness bootstraps through `appConfig`, and every vitest spec in this lab builds its own
 * providers.
 */
export const appFormattingContext = Object.freeze({
  timeZone: 'UTC',
  calendar: 'gregory',
  numberingSystem: 'latn',
  hourCycle: 'h23',
});

/**
 * The one social fact a deployment has to supply, and the reason Atlas asks for it.
 *
 * `og:image` is required by ogp.me and is an absolute URL to this application's own artwork, so it
 * can only come from here: an image URL inside Atlas would be consumer content in a
 * product-neutral library. Supplying it is also what turns the Open Graph block on: everything else
 * in that block, including the `og:locale` spelling that is the whole point, Atlas derives.
 */
const SOCIAL_PREVIEW = {
  image: 'https://atlas.example/social/preview.png',
  card: 'summary_large_image',
  // A brand name, not a sentence. It is the same string in every language on purpose, which is why
  // it stays here and the alt text does not: alt text describes a picture to someone who cannot
  // see it, and that is reading, so it comes from the catalog below.
  siteName: 'Atlas package consumer',
} as const;

/**
 * What each route's document says, declared once per route id.
 *
 * This replaced a conditional chain on `context.resolution.routeId` inside the `document` callback,
 * which answered with the same two strings for every route in the application, so `/second` and
 * `/items/42` and `/lazy` all claimed to be the home page, in both languages, and nothing said so.
 * A chain always has a last branch, so it never stops compiling and never stops answering.
 *
 * They are messages rather than strings for one reason worth stating: `atlas check
 * --require-complete` already fails when a target catalog omits a message, so a title with no Arabic
 * translation is a build failure and not a page that quietly serves English. A bespoke metadata
 * format would have needed its own completeness check, and a second completeness mechanism is one
 * that drifts from the first.
 *
 * `article` is deliberately absent. Its title is the fetched article's own, so no catalog can hold
 * it, and it comes from the `document` callback instead, which is what that callback is now for.
 */
const ROUTE_DOCUMENTS = {
  'route:_index': {
    title: messages.document.title,
    description: messages.document.description,
  },
  'route:second': {
    title: messages.document.second.title,
    description: messages.document.second.description,
  },
  item: {
    title: messages.document.item.title,
    description: messages.document.item.description,
  },
  'route:lazy': {
    title: messages.document.lazy.title,
    description: messages.document.lazy.description,
  },
  topic: {
    title: messages.document.topic.title,
    description: messages.document.topic.description,
  },
  dossier: {
    title: messages.document.dossier.title,
    description: messages.document.dossier.description,
  },
} as const;

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    // One call, and it is the whole of this application's routing. It wraps `provideRouter`,
    // derives the locale branches from the route projection, installs the localized
    // `LocationStrategy` and the address sync, and carries the route localization that would
    // otherwise be a second provider call. Adding a route, adding a locale or changing one path
    // spelling in one locale touches none of it.
    //
    // No `LocationStrategy` provider line: Atlas installs its own from inside, as
    // `withHashLocation()` does, and warns in development if anything else wins the token.
    //
    // No `withRouterConfig` either. Atlas needs nothing from `canceledNavigationResolution`: the
    // two modes differ only on a cancelled navigation, and the difference reproduces identically
    // with Atlas and without it. Passing one here warns, because Angular provides
    // ROUTER_CONFIGURATION non-multi and a consumer's feature replaces Atlas's config entirely.
    provideLocalizedRouter(
      routes,
      {
        origin: SITE_ORIGIN,
        documentMetadata: ROUTE_DOCUMENTS,
        // What no catalog can hold: the article's own title, and the preview image URL. Everything
        // static is above, so this is down to the two facts that are genuinely dynamic and the one
        // that is genuinely this deployment's.
        document: (context, localization) => {
          const article = inject(DynamicContentStore).article();
          const social = {
            ...SOCIAL_PREVIEW,
            imageAlt: localization.text(messages.social.imageAlt),
          };
          return context.resolution.routeId === 'article' &&
            article !== undefined
            ? { title: article.title, description: article.summary, social }
            : { social };
        },
      },
      // An ordinary application setting, and the one that makes interaction preservation provable.
      // A locale switch is a navigation, so with restoration on the Router sends the page to the
      // top and Atlas has to put the visitor back. Without it nothing moves, the hook restores
      // what was never lost, and the scroll assertions below pass whether Atlas acts or not.
      withInMemoryScrolling({ scrollPositionRestoration: 'top' }),
    ),
    // The one line Atlas asks an application to write, and the reason it is a line rather than
    // something `provideLocalizedRouter` does. Angular offers no router feature for this token, so
    // claiming it from inside would silently replace a strategy an application had set on purpose,
    // and applications do set it. Omitting the line is not silent: `provideLocalizedRouter`
    // warns in development as soon as any route declares a title, which `app.routes.ts` now does.
    { provide: TitleStrategy, useClass: LocalizedTitleStrategy },
    provideClientHydration(withEventReplay()),
    // One import, one call. The configuration, catalog set, loaders, recovery payload and startup
    // scopes are all things Atlas generated, so importing each one here by hand would be passing
    // them straight back. What remains is what this application actually decides.
    provideLocalization(
      withExtensions(atlasRuntimeExtensions),
      // The locale URL policy, declared once. The Router integration, the `url` locale source,
      // canonical URLs and reciprocal `hreflang` links all read this one copy; the route table
      // itself is not here because Atlas generated it and passes it already.
      withRouting({
        policy: routePolicy,
        projection: appRouteProjection,
        // Read from this file's source text when Atlas compiles this owner, like the indexing
        // field, and inert at runtime. `priority` is a number here and a string would not do:
        // route data carries the class, and the class is what carries the numbers.
        sitemap: {
          field: 'section',
          values: {
            landing: { changefreq: 'daily', priority: 1 },
            reference: { changefreq: 'monthly', priority: 0.5 },
          },
          lastmodField: 'updated',
        },
      }),
      // No `withLocaleSources` line. This application wants Atlas's order (URL, then what this
      // visitor chose before, then what their client asked for, then the configured default) and
      // that is the default, so writing it out said nothing and made a second place to maintain.
      // `locale-sources.spec.ts` asserts the order this application actually negotiates, so the
      // default changing under it is a test failure rather than a silent behaviour change.
      //
      // `locale-cookie.ts` and not a literal: `server.ts` writes the same cookie, and when the
      // two were declared separately they disagreed about `Secure` and only WebKit said so.
      withPersistence(cookieStore(localeCookie)),
      withRecoveryMessage({
        message: messages.recovery.unavailable,
        retryLabel: messages.control.retry,
      }),
      withFormattingContext(appFormattingContext),
      // Declared rather than defaulted. `systemClock()` is what Atlas would install anyway, and
      // naming it is what makes the substitution in a test a change to one line rather than a
      // change of shape: the application already says which clock it uses.
      withLocalizationClock(systemClock()),
    ),
    provideDynamicContent(),
  ],
};
