/**
 * What a built consumer refuses: a hostile catalog, a hostile transfer, and a ceiling plus one.
 *
 * These run against the published packages rather than the source, so the admission path under
 * test is the one a consumer installs: `specs/05-compiled-artifacts-and-trust.spec.md` section 4.
 * The accessor and cycle cases are section 1 of
 * `specs/05-compiled-artifacts-and-trust.spec.md`, and the transfer block below is section 2 of
 * `specs/05-compiled-artifacts-and-trust.spec.md`.
 */
import { TestBed } from '@angular/core/testing';
import { APP_ID } from '@angular/core';
import { describe, expect, it } from 'vitest';

import {
  Localization,
  createLocalizationContext,
  decimal,
  defineRuntimeExtensions,
  externalDestination,
  internalDestination,
  parseLocalizedInput,
  provideLocalizationSetup,
  type CatalogLoaders,
  type RuntimeExtensionBinding,
  type RuntimeFormattingAdapterDescriptor,
} from '@neolorn/atlas';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { messages, providerId, scopeId } from '#i18n/shell';
import {
  providerId as lazyProviderId,
  scopeId as lazyScopeId,
} from '#i18n/lazy';

import { atlasRuntimeExtensions } from './runtime-extensions';

const scope = Object.freeze({ providerId, scopeId });
const lazyScope = Object.freeze({
  providerId: lazyProviderId,
  scopeId: lazyScopeId,
});
const sourceCatalogKey = `${providerId}:${scopeId}:en-US`;

function setup(loaders: CatalogLoaders = catalogLoaders) {
  return {
    configuration,
    catalogSet,
    catalogLoaders: loaders,
    extensions: atlasRuntimeExtensions,
  } as const;
}

function context(loaders: CatalogLoaders = catalogLoaders) {
  return createLocalizationContext({
    setup: setup(loaders),
    bootstrapScopes: [scope],
  });
}

async function sourceCatalog(): Promise<unknown> {
  const loaders: CatalogLoaders = catalogLoaders;
  const loader = loaders[sourceCatalogKey];
  if (loader === undefined) throw new Error('Source catalog loader is absent.');
  return loader();
}

describe('fixed runtime ceilings', () => {
  it('admits exact limits and rejects limit plus one before costly work', () => {
    const exactDigits = '1'.repeat(65_536);
    expect(decimal(exactDigits).value).toHaveLength(65_536);
    expect(() => decimal(`${exactDigits}1`)).toThrow(/decimal/u);

    const profile = {
      kind: 'decimal',
      maximumCharacters: 65_536,
    } as const;
    const formatting = { locale: 'en-US' } as const;
    expect(parseLocalizedInput(exactDigits, profile, formatting)).toMatchObject(
      { status: 'valid' },
    );
    expect(
      parseLocalizedInput(`${exactDigits}1`, profile, formatting),
    ).toMatchObject({ status: 'out-of-range' });

    expect(internalDestination(`/${'a'.repeat(8_191)}`).href).toHaveLength(
      8_192,
    );
    expect(() => internalDestination(`/${'a'.repeat(8_192)}`)).toThrow(
      /safe origin-relative URL/u,
    );
  });

  it('rejects spoofing controls, oversized allowlists, and unsupported targets', () => {
    expect(() => internalDestination('/safe\u202epath')).toThrow(
      /safe origin-relative URL/u,
    );
    expect(() =>
      externalDestination(
        'https://atlas.example/path',
        ['https://atlas.example'],
        '_parent' as '_blank',
      ),
    ).toThrow(/safety policy/u);
    expect(() =>
      externalDestination(
        'https://atlas.example/path',
        Array.from({ length: 65 }, () => 'https://atlas.example'),
      ),
    ).toThrow(/safety policy/u);
  });
});

describe('closed configuration admission', () => {
  it('ignores inherited alias names and rejects duplicate or overlapping scopes', async () => {
    const localization = context();
    await localization.initialize();
    await expect(localization.changeLocale('toString')).resolves.toMatchObject({
      status: 'failed',
    });
    expect(() =>
      localization.changeLocale('en-US', {
        requiredScopes: [scope],
        progressiveScopes: [scope],
      }),
    ).toThrow(/cannot overlap/u);
    await expect(localization.changeLocale('ar-EG')).resolves.toMatchObject({
      status: 'committed',
    });
    expect(localization.text(messages.appTitle)).toContain('Atlas');
    localization.dispose();

    expect(() =>
      createLocalizationContext({
        setup: setup(),
        bootstrapScopes: [scope, { ...scope }],
      }),
    ).toThrow(/duplicate generated scope/u);
  });

  it('copies and freezes descriptors, then rejects cycles and post-admission mutation', () => {
    const generated = configuration.extensionDescriptors?.find(
      (descriptor) => descriptor.kind === 'formatting-adapter',
    );
    if (generated?.kind !== 'formatting-adapter') {
      throw new Error('Formatting descriptor is absent.');
    }
    const mutable = structuredClone(
      generated,
    ) as RuntimeFormattingAdapterDescriptor;
    const admitted = defineRuntimeExtensions([
      {
        descriptor: mutable,
        format: ({ value }) => ({ text: String(value) }),
      },
    ]);
    const admittedDescriptor = admitted[0]?.descriptor;
    if (admittedDescriptor?.kind !== 'formatting-adapter') {
      throw new Error('Formatting binding admission failed.');
    }
    expect(admittedDescriptor).not.toBe(mutable);
    expect(Object.isFrozen(admittedDescriptor)).toBe(true);
    (mutable as { maximumOutputLength: number }).maximumOutputLength = 1;
    expect(admittedDescriptor?.maximumOutputLength).toBe(
      generated.maximumOutputLength,
    );

    const cyclic = structuredClone(generated) as unknown as Record<
      string,
      unknown
    >;
    cyclic['cycle'] = cyclic;
    expect(() =>
      defineRuntimeExtensions([
        {
          descriptor: cyclic,
          format: ({ value }: { readonly value: unknown }) => ({
            text: String(value),
          }),
        } as unknown as RuntimeExtensionBinding,
      ]),
    ).toThrow(/cycle|inert/iu);
  });
});

describe('catalog and lifetime admission', () => {
  it('deep-copies an admitted catalog so later mutation cannot change evaluation', async () => {
    const candidate = structuredClone(await sourceCatalog()) as {
      messages: Array<{
        messageId: string;
        body: { pattern?: unknown[] };
      }>;
    };
    const loaders = {
      ...catalogLoaders,
      [sourceCatalogKey]: () => candidate,
    } satisfies CatalogLoaders;
    const localization = context(loaders);
    await localization.initialize();
    const before = localization.text(messages.appTitle);
    const appTitle = candidate.messages.find(
      ({ messageId }) => messageId === 'app-title',
    );
    if (appTitle?.body.pattern !== undefined) {
      appTitle.body.pattern[0] = 'HOSTILE MUTATION';
    }
    expect(localization.text(messages.appTitle)).toBe(before);
    localization.dispose();
  });

  it.each(['summary', 'cycle', 'accessor'] as const)(
    'rejects a hostile %s catalog before cache admission',
    async (kind) => {
      const candidate = structuredClone(await sourceCatalog()) as {
        resources: { irNodes: number };
        messages: Array<{ body: Record<string, unknown> }>;
      };
      if (kind === 'summary') candidate.resources.irNodes += 1;
      if (kind === 'cycle') candidate.messages[0]!.body['cycle'] = candidate;
      if (kind === 'accessor') {
        Object.defineProperty(candidate.messages[0]!.body, 'hostile', {
          enumerable: true,
          get: () => 'unsafe',
        });
      }
      const localization = context({
        ...catalogLoaders,
        [sourceCatalogKey]: () => candidate,
      });
      await expect(localization.initialize()).rejects.toThrow(
        /catalog.*admission|inert JSON/iu,
      );
      localization.dispose();
    },
  );

  it('settles preload when disposal aborts a never-settling loader', async () => {
    const localization = context();
    await localization.initialize();
    localization.dispose();

    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const never = new Promise<never>(() => undefined);
    const lazySourceKey = `${lazyProviderId}:${lazyScopeId}:en-US`;
    const pending = context({
      ...catalogLoaders,
      [lazySourceKey]: () => {
        started();
        return never;
      },
    });
    const initialization = pending.initialize();
    await initialization;
    const preload = pending.preloadScope(lazyScope);
    await didStart;
    pending.dispose();
    await expect(preload).rejects.toThrow(/disposed/u);
  });
});

/**
 * What arrives with a server-rendered document, delivered the way a document delivers it.
 *
 * Seeding the transfer with `TestBed.inject(TransferState).set(...)` and then injecting
 * `Localization`, which reads it, never lets the runtime see the value. `TestBed.inject` of
 * anything calls `finalize()`, which runs the app initializers (Angular 22.1.3,
 * `testing.mjs:720`), and Atlas's initializer injects `Localization`, whose factory reads the
 * transfer at construction. The first `inject` in such a test builds the runtime against an empty
 * store, and the `set` on the line above the assertion runs after the read it is seeding: the test
 * asserts a fallback the sanitizer has nothing to do with, and passes for whatever the sanitizer
 * does.
 *
 * Reordering does not answer it. `TransferState` is `providedIn: 'root'` and its factory
 * calls `retrieveTransferredState(document, APP_ID)`, which reads
 * `<script id="ng-state" type="application/json">` and `JSON.parse`s it, so the document is the
 * real delivery path, it runs before any test code can interleave with it, and it is the boundary
 * `sanitizeTransferSnapshot` exists to guard. Seeding it there is both correct and closer to the
 * threat.
 *
 * *And the cyclic payload is gone rather than moved.* A transfer arrives as JSON text and JSON
 * cannot express a cycle, so that input could not reach this function from a browser; on the
 * server `TransferState.toJson` is `JSON.stringify`, which throws on one, so it cannot reach it
 * from there either. The cycle branch of `snapshotInertJson` is real and is exercised where a
 * cycle can exist: `defineRuntimeExtensions`, in this file, against a live object.
 */
describe('hostile transfer state', () => {
  const KEY = '@neolorn/atlas:localization-state/1';
  /**
   * The application id this test delivers under, stated rather than assumed.
   *
   * Angular names the transfer element `<appId>-state`, and the id is injectable, so the element
   * has to exist before the injector that could tell you its name. Assuming Angular's documented
   * default of `ng` reads an empty store, because under this builder the id is `a`. Providing it
   * fixes both halves of the pair from one value, and a builder that changes its default again
   * cannot quietly empty this block.
   */
  const APP = 'atlas-transfer-lab';
  const valid = (route?: unknown): Record<string, unknown> => ({
    profile: 'atlas-transfer-state/1',
    primaryLocale: 'ar-EG',
    formatting: { locale: 'ar-EG' },
    catalogs: [],
    participants: [],
    ...(route === undefined ? {} : { route }),
  });

  /** Boot a runtime with this payload in the document, and report what it adopted. */
  const adopt = async (
    payload: unknown,
  ): Promise<{ locale: string | undefined; route: unknown }> => {
    TestBed.resetTestingModule();
    const script = document.createElement('script');
    script.id = `${APP}-state`;
    script.type = 'application/json';
    // `textContent`, not `innerHTML`: the value is data and must not be parsed as markup on the
    // way in. Angular escapes `<` and `/` when it writes this tag for the same reason.
    script.textContent = JSON.stringify({ [KEY]: payload });
    document.body.appendChild(script);
    try {
      await TestBed.configureTestingModule({
        providers: [
          { provide: APP_ID, useValue: APP },
          provideLocalizationSetup(setup()),
        ],
      }).compileComponents();
      const localization = TestBed.inject(Localization);
      await localization.initialize();
      const snapshot = localization.snapshot();
      const adopted = {
        locale: snapshot?.primaryLocale,
        route: snapshot?.route,
      };
      localization.dispose();
      return adopted;
    } finally {
      script.remove();
      TestBed.resetTestingModule();
    }
  };

  // The control, and it is what makes every refusal below mean something. Without it a suite that
  // delivers nothing at all is green on all five cases, which is exactly what this block was.
  it('adopts a transfer the server could have written', async () => {
    expect(await adopt(valid())).toMatchObject({ locale: 'ar-EG' });
  });

  it('carries the switch addresses through, and only as paths', async () => {
    const route = {
      routeId: 'route:_index',
      projectionIdentity: `sha256-${'A'.repeat(43)}`,
      canonicalPath: '/ar-eg',
      addresses: { 'en-US': '/en-us', 'ar-EG': '/ar-eg' },
    };
    expect((await adopt(valid(route))).route).toMatchObject({
      canonicalPath: '/ar-eg',
      addresses: { 'en-US': '/en-us', 'ar-EG': '/ar-eg' },
    });
  });

  it('drops the whole transfer for anything it does not recognise', async () => {
    const refused: readonly [string, unknown][] = [
      ['not a record', ['atlas-transfer-state/1']],
      ['a profile from something else', { ...valid(), profile: 'other/1' }],
      ['a key the profile does not declare', { ...valid(), extra: 1 }],
      [
        'a formatting locale disagreeing with the primary',
        { ...valid(), formatting: { locale: 'en-US' } },
      ],
      [
        'a script URL where a path belongs',
        valid({
          routeId: 'route:_index',
          projectionIdentity: `sha256-${'A'.repeat(43)}`,
          canonicalPath: 'javascript:alert(1)',
        }),
      ],
      [
        'a switch address on another origin',
        valid({
          routeId: 'route:_index',
          projectionIdentity: `sha256-${'A'.repeat(43)}`,
          canonicalPath: '/ar-eg',
          addresses: { 'ar-EG': '//evil.example/ar-eg' },
        }),
      ],
      [
        'one catalog more than a transfer may carry: the bound, not a round number',
        { ...valid(), catalogs: Array.from({ length: 513 }, () => ({})) },
      ],
    ];
    for (const [reason, payload] of refused) {
      // The generated default, which is what a runtime that adopted nothing reports. One edited
      // field drops the whole transfer rather than the field: a transfer with one bad value is a
      // transfer someone has been inside.
      expect((await adopt(payload)).locale, reason).toBe('en-US');
    }
  });
});
