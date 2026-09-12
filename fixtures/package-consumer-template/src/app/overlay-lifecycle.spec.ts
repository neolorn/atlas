import { describe, expect, it } from 'vitest';

import { PLATFORM_ID, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  Localization,
  provideLocalizationSetup,
  withOverlayLocale,
  type LocalizationOverlayAdapter,
  type LocalizationSnapshot,
} from '@neolorn/atlas';
import { configuration } from '#i18n';
import { catalogLoaders } from '#i18n/catalog-loaders';
import { catalogSet } from '#i18n/catalog-set';
import { recoveryPayload } from '#i18n/recovery-payload';
import { providerId, scopeId } from '#i18n/shell';

import { atlasRuntimeExtensions } from './runtime-extensions';

/**
 * Overlay adapters under server rendering.
 *
 * `withOverlayLocale` took an adapter object. An Angular application config is a module-level
 * constant, so on a server that object is created once for the process and every concurrent
 * request shares it, with one request's overlay roots receiving another request's language, and
 * the
 * first context to be destroyed calls `dispose()` on it, permanently, for every request still in
 * flight and every request after them.
 *
 * The deferral of this finding argued that overlays are browser-side. They are not, wherever an
 * application server-renders: overlay state has to be present before components paint on
 * server-rendered and prerendered routes, overlay-root context divergence is a hydration hazard,
 * and the server and client have to agree on overlay-root direction. Direction is Atlas-owned, so
 * an Atlas overlay adapter is live during server rendering.
 *
 * It takes a factory now, which is the same correction persistence stores needed, for the same
 * reason: request-scoped state must be created by the injector that owns the request.
 *
 * `specs/09-safe-content-and-ux.spec.md` section 13 requires the adapter to be created once per
 * injector for that reason, and requires a coordinated overlay to change with the primary
 * commit rather than after it.
 */

const shellScope = { providerId, scopeId } as const;

interface RecordingAdapter extends LocalizationOverlayAdapter {
  readonly applied: string[];
  readonly disposals: number[];
}

function recordingAdapter(): RecordingAdapter {
  const applied: string[] = [];
  const disposals: number[] = [];
  return {
    applied,
    disposals,
    apply: (snapshot: LocalizationSnapshot) => {
      applied.push(snapshot.primaryLocale);
    },
    dispose: () => {
      disposals.push(applied.length);
    },
  };
}

function serverRequest(create: () => LocalizationOverlayAdapter): Localization {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: 'server' },
      provideLocalizationSetup(
        {
          configuration,
          catalogSet,
          catalogLoaders,
          recoveryPayload,
          extensions: atlasRuntimeExtensions,
        },
        withOverlayLocale(create),
      ),
    ],
  });
  return TestBed.inject(Localization);
}

describe('one adapter per request', () => {
  it('gives each request its own adapter', async () => {
    const created: RecordingAdapter[] = [];
    const create = () => {
      const adapter = recordingAdapter();
      created.push(adapter);
      return adapter;
    };

    const first = serverRequest(create);
    await first.initialize();
    await first.changeLocale('ar-EG');

    const second = serverRequest(create);
    await second.initialize();

    expect(created).toHaveLength(2);
    // The Arabic request's overlays are the Arabic request's alone. Sharing one adapter put one
    // visitor's language onto another visitor's overlay roots.
    expect(created[0]?.applied).toContain('ar-EG');
    expect(created[1]?.applied).not.toContain('ar-EG');
  });

  it('disposes only the request that ended', async () => {
    // The half of this that is unrecoverable. A shared adapter is disposed by whichever request
    // finishes first, and every request after it renders overlays against a disposed adapter for
    // the remaining life of the process.
    const created: RecordingAdapter[] = [];
    const create = () => {
      const adapter = recordingAdapter();
      created.push(adapter);
      return adapter;
    };

    const first = serverRequest(create);
    await first.initialize();
    TestBed.resetTestingModule();

    expect(created[0]?.disposals).toHaveLength(1);

    const second = serverRequest(create);
    await second.initialize();

    expect(created[1]?.disposals).toHaveLength(0);
    expect(created[1]?.applied).toContain('en-US');
  });

  it('builds the adapter inside the injector that owns the request', async () => {
    // The factory runs in an injection context, so an adapter may inject the overlay container,
    // the document, or anything else that belongs to this request rather than to the process.
    let platform: unknown;
    const localization = serverRequest(() => {
      platform = inject(PLATFORM_ID);
      return recordingAdapter();
    });
    await localization.initialize();

    expect(platform).toBe('server');
  });
});
