import {
  REQUEST_CONTEXT,
  TransferState,
  inject,
  makeStateKey,
  provideAppInitializer,
} from '@angular/core';
import { PlatformLocation } from '@angular/common';
import { Localization, localeFromRoute } from '@neolorn/atlas';
import { configuration } from '#i18n';

import { routePolicy, appRouteProjection } from './localization.routes';

export interface SsrProbeSnapshot {
  readonly requestId: string;
  readonly label: string;
  readonly locale: string;
  readonly source: 'server-transfer' | 'browser-fallback';
  /**
   * The locale this request's URL stated, or `'unstated'` when it stated none.
   *
   * Not the same question as `locale` above, and the difference is the point: `locale` is the
   * locale Atlas committed to, which on an unprefixed request is the negotiated default. This says
   * whether the *address* asked for it. A response whose body depends on negotiation rather than on
   * the URL is the one that needs `Vary`, and the server cannot tell those apart from the committed
   * locale alone.
   *
   * `resolveInitialRouteLocale` cannot answer it: it returns the default when the URL says
   * nothing, which is the right answer for choosing a locale and the wrong one for asking what the
   * URL said.
   */
  readonly urlStatedLocale: string;
  /**
   * The address `PlatformLocation` reports during this render, or `'unavailable'`.
   *
   * This exists to measure one thing that everything else here assumes. Atlas derives the
   * server-side address from `PlatformLocation` rather than from `REQUEST_CONTEXT`, because
   * `@angular/ssr` provides `REQUEST_CONTEXT` only when the render mode is `Server`: a
   * prerendered page has none, and reading it there resolved every prerendered address to the
   * default locale.
   *
   * That swap rests on `PlatformLocation` being injectable from an application-config-level
   * factory *and* carrying the address actually being rendered, under prerendering as well as
   * SSR. Recorded from an app initializer, which runs in the same environment injector Atlas's
   * own factory does, so a value here is evidence about that factory rather than about this one.
   */
  readonly platformPath: string;
}

interface SsrProbeRequestContext {
  readonly requestId: string;
  readonly label: string;
}

export const SSR_PROBE_STATE_KEY = makeStateKey<SsrProbeSnapshot>(
  'atlas-feature-lab-ssr-probe',
);

export const BROWSER_FALLBACK_SNAPSHOT: SsrProbeSnapshot = {
  requestId: 'missing-request-context',
  label: 'missing-transfer-state',
  locale: configuration.defaultLocale,
  source: 'browser-fallback',
  urlStatedLocale: 'unstated',
  platformPath: 'unavailable',
};

function isSsrProbeRequestContext(
  value: unknown,
): value is SsrProbeRequestContext {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const context = value as Record<string, unknown>;
  return (
    typeof context['requestId'] === 'string' &&
    context['requestId'].length > 0 &&
    typeof context['label'] === 'string' &&
    context['label'].length > 0
  );
}

export function provideSsrProbe() {
  return provideAppInitializer(async () => {
    const requestContext = inject(REQUEST_CONTEXT);
    const platformLocation = inject(PlatformLocation, { optional: true });
    const localization = inject(Localization);
    const transferState = inject(TransferState);
    const snapshotContext = isSsrProbeRequestContext(requestContext)
      ? requestContext
      : {
          requestId: 'build-route-extraction',
          label: 'build-route-extraction',
        };

    const localizationSnapshot = await localization.initialize();
    transferState.set(SSR_PROBE_STATE_KEY, {
      requestId: snapshotContext.requestId,
      label: snapshotContext.label,
      locale: localizationSnapshot.primaryLocale,
      source: 'server-transfer',
      urlStatedLocale:
        localeFromRoute(requestContext, routePolicy, appRouteProjection) ??
        'unstated',
      platformPath:
        platformLocation === null ? 'unavailable' : platformLocation.pathname,
    });
  });
}
