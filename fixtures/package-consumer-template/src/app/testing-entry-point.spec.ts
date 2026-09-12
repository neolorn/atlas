import { describe, expect, it } from 'vitest';

import {
  Localization,
  createLocalizationContext,
  provideLocalizationSetup,
} from '@neolorn/atlas';
import {
  createInMemoryCatalogLoaders,
  provideLocalizationTesting,
} from '@neolorn/atlas/testing';
import { TestBed } from '@angular/core/testing';
import { localizationSetup } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { messages, providerId, scopeId } from '#i18n/shell';

import { atlasRuntimeExtensions } from './runtime-extensions';

/**
 * The `@neolorn/atlas/testing` entry point, used the way a consumer would.
 *
 * `createInMemoryCatalogLoaders` is unusable if its loader resolves the wrapper object it was
 * handed rather than the compiled catalog inside it, because catalog admission refuses that, and
 * nothing else in the repository calls it, so nothing notices. A published helper that cannot work
 * is worse than an absent one: it costs a consumer the afternoon they spend assuming the fault is
 * theirs.
 *
 * Every application in a workspace needs this entry point for its own test suite, which is why it
 * is exercised here rather than left to a consumer to discover.
 */

const shellScope = { providerId, scopeId } as const;

describe('createInMemoryCatalogLoaders', () => {
  it('delivers catalogs that admission accepts', async () => {
    // The real compiled artifacts, reached through the generated loaders, then re-served through
    // the testing helper. If the helper hands back the wrong object, admission refuses it and
    // initialization fails.
    // The generated loader map is exactly typed, so the identity is read from it rather than
    // rebuilt as a string the type system cannot check.
    const loaders = catalogLoaders as Readonly<
      Record<string, () => Promise<unknown>>
    >;
    // Every declared artifact, because catalog admission validates the whole declared set: a
    // loader map covering a subset is refused as an incomplete descriptor, whatever the artifacts
    // in it are.
    const entries = await Promise.all(
      Object.entries(loaders).map(async ([identity, load]) => {
        const [entryProvider, entryScope, entryLocale] = identity.split(':');
        return {
          key: {
            providerId: entryProvider as string,
            scopeId: entryScope as string,
            catalogLocale: entryLocale as string,
          },
          catalog: await load(),
        };
      }),
    );

    const inMemory = createInMemoryCatalogLoaders(entries);

    expect(Object.keys(inMemory).sort()).toEqual(Object.keys(loaders).sort());

    const localization = createLocalizationContext({
      // The generated setup with one field substituted, which is the whole point of the test: the
      // in-memory loaders stand where the generated ones did, and everything else is what the
      // application itself would run with.
      setup: {
        ...localizationSetup,
        catalogLoaders: inMemory,
        extensions: atlasRuntimeExtensions,
      },
      bootstrapScopes: [shellScope],
      initialLocale: 'en-US',
    });

    await localization.initialize();
    expect(localization.text(messages.appTitle)).toBe('Atlas feature lab');
    localization.dispose();
  });
});

describe('provideLocalizationTesting', () => {
  it('composes the same runtime the application provider does', async () => {
    // The entry point's other export, exercised through Angular rather than asserted to be a
    // function. It is what a consumer's test suite reaches for first.
    //
    // `localizationSetup` is the same value the generated `provideLocalization()` composes, which
    // is what makes this case's name true. Hand-copying the setup instead copies five of the six
    // fields (no `personNames`, no `routeProjection`), so a case called "composes the same runtime
    // the application provider does" composes a different one and nothing can notice.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideLocalizationTesting({
          ...localizationSetup,
          extensions: atlasRuntimeExtensions,
        }),
      ],
    });

    const localization = TestBed.inject(Localization);
    await localization.initialize();

    expect(localization.text(messages.appTitle)).toBe('Atlas feature lab');
    await localization.changeLocale('ar-EG');
    expect(localization.text(messages.appTitle)).toBe('مختبر ميزات Atlas');
  });

  it('is a different entry point from the application provider, not a different runtime', () => {
    expect(typeof provideLocalizationSetup).toBe('function');
    expect(typeof provideLocalizationTesting).toBe('function');
  });
});
