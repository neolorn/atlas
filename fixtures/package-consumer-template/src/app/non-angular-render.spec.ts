import { describe, expect, it } from 'vitest';

import {
  createLocalizationContext,
  formatInstant,
  instant,
  languagePresentation,
} from '@neolorn/atlas';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';
import { messages, providerId, scopeId } from '#i18n/shell';

import { atlasRuntimeExtensions } from './runtime-extensions';

/**
 * Localized text with no Angular application.
 *
 * A localized page is the right response to a fatal server error, and that page has to render at
 * the moment the application did not: no bootstrap, no injector hierarchy, no component tree, no
 * router. `createLocalizationContext` is the framework-neutral entry that has to make that
 * possible, and nothing proved it did: every fixture reached the runtime through
 * `provideLocalization` and Angular's TestBed, which is the situation a fatal-500 handler is
 * definitionally not in.
 *
 * What is asserted here is exactly what can be: no `TestBed`, no `provideLocalization`, no
 * component, no template, no change detection. The runtime module imports `@angular/core` for
 * signals, so that module is loaded, but nothing in this file creates an Angular application, and
 * that is the distinction a 500 handler depends on.
 */

const shellScope = { providerId, scopeId } as const;

function context() {
  return createLocalizationContext({
    setup: {
      configuration,
      catalogSet,
      catalogLoaders,
      recoveryPayload,
      extensions: atlasRuntimeExtensions,
    },
    bootstrapScopes: [shellScope],
  });
}

describe('a localization context built without Angular', () => {
  it('produces localized text from the compiled catalogs', async () => {
    const localization = context();
    await localization.initialize();

    expect(localization.text(messages.appTitle)).toBe('Atlas feature lab');

    await localization.changeLocale('ar-EG');
    expect(localization.text(messages.appTitle)).toBe('مختبر ميزات Atlas');

    localization.dispose();
  });

  it('reports the direction the page has to be rendered in', async () => {
    // A 500 page needs `dir` before it needs anything else: an Arabic error page laid out
    // left-to-right is a broken page, not a degraded one.
    const localization = context();
    await localization.initialize();
    await localization.changeLocale('ar-EG');

    expect(localization.snapshot()?.direction).toBe('rtl');
    expect(languagePresentation('ar-EG').direction).toBe('rtl');

    localization.dispose();
  });

  it('formats the values an error page carries', async () => {
    // A reference and a timestamp are what a fatal page can honestly show.
    const formatted = formatInstant(
      instant('1800000000123456700'),
      { locale: 'ar-EG', timeZone: 'Africa/Cairo' },
      { dateStyle: 'long' },
    );

    expect(formatted.ok).toBe(true);
    if (!formatted.ok) return;
    expect(formatted.value.direction).toBe('rtl');
    expect(formatted.value.text).toMatch(/[؀-ۿ]/u);
  });

  it('recovers a message when the catalogs cannot be reached at all', async () => {
    // The worse case behind the worse case: the localized page itself needs a catalog, and the
    // reason the server is answering 500 may be that nothing loads. Recovery is the answer that
    // does not depend on the thing that failed.
    const localization = createLocalizationContext({
      setup: {
        configuration,
        catalogSet,
        // The real loader map, every entry replaced by one that cannot deliver. Keeping the map's
        // shape matters: a fabricated one is rejected as an invalid descriptor, which would prove
        // the wrong thing.
        catalogLoaders: Object.freeze(
          Object.fromEntries(
            Object.keys(catalogLoaders).map((identity) => [
              identity,
              () => Promise.reject(new Error('storage is unreachable')),
            ]),
          ),
        ),
        recoveryPayload,
        extensions: atlasRuntimeExtensions,
      },
      bootstrapScopes: [shellScope],
      // The framework-neutral equivalent of `withRecoveryMessage`. Selecting it here is the whole
      // point: a 500 handler has no provider array to declare it in.
      recoveryMessage: messages.recovery.unavailable,
    });

    await expect(localization.initialize()).rejects.toThrow();
    expect(localization.recovery()?.value.length ?? 0).toBeGreaterThan(0);

    localization.dispose();
  });
});
