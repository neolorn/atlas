import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createLocaleRequestHandler,
  declareOperationalFailure,
  type LocaleRenderer,
} from '../http/src/handler.js';
import type {
  LocaleUrlPolicy,
  RouteRuntimeProjection,
} from '@neolorn/atlas/core';

const CACHE = { successMaxAge: 600, permanentRedirectMaxAge: 86_400 } as const;

const POLICY: LocaleUrlPolicy = {
  kind: 'path-prefix',
  defaultLocale: 'en-US',
  locales: { 'en-US': 'en-us', 'ar-EG': 'ar-eg' },
  prefixes: { 'en-us': 'en-US', 'ar-eg': 'ar-EG' },
  aliases: {},
  localeNeutralRoots: ['assets'],
  omitDefaultPrefix: false,
};

const PROJECTION: RouteRuntimeProjection = {
  generated: {
    profile: 'atlas-route-projection/1',
    identity: 'sha256-AtlasBuiltLocaleAddressesTestIdentity012345',
    routes: [
      { id: 'route:_index', path: '', parameterNames: [] },
      { id: 'route:second', path: 'second', parameterNames: [] },
    ],
  },
  localizedPaths: { 'route:second': { 'en-US': 'second', 'ar-EG': 'second' } },
};

const MAINTENANCE = '<!doctype html><html lang="en-US">maintenance</html>';

const handlerWith = (render: LocaleRenderer) =>
  createLocaleRequestHandler({
    policy: POLICY,
    projection: PROJECTION,
    cache: CACHE,
    cookie: { name: 'atlas-locale' },
    render,
  });

/** A renderer that declares an operational failure at every address it is asked about. */
const declaresFailure =
  (status = 503): LocaleRenderer =>
  () =>
    declareOperationalFailure(
      new Response(MAINTENANCE, {
        status,
        headers: { 'content-type': 'text/html', 'retry-after': '600' },
      }),
    );

/** The control: an ordinary renderer, which is every consumer written before this existed. */
const rendersPage: LocaleRenderer = ({ locale }) =>
  new Response(`<!doctype html><html lang="${locale}"></html>`, {
    headers: { 'content-type': 'text/html' },
  });

const get = (handler: ReturnType<typeof handlerWith>, path: string) =>
  handler(new Request(`https://atlas.example${path}`));

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The status of a rendered response, at an address that resolved.
 *
 * Serving maintenance and reporting a render that failed are ordinary, and neither is a routing
 * outcome: the address is fine, the application is not. Section 5 of
 * `specs/07-routing-rendering-and-seo.spec.md` gives that status to the application and requires
 * the declaration to be a distinct result, so that a 500 nobody meant and a 503 somebody chose are
 * never the same signal.
 */
describe('a status the renderer declares for itself', () => {
  it('travels at an address Atlas serves', async () => {
    const response = await get(handlerWith(declaresFailure()), '/en-us/second');

    expect(response.status).toBe(503);
    expect(await response.text()).toContain('maintenance');
  });

  it('keeps the headers the declaration carried', async () => {
    const response = await get(handlerWith(declaresFailure()), '/en-us/second');

    expect(response.headers.get('retry-after')).toBe('600');
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('still answers in the locale Atlas resolved', async () => {
    // The failure replaces the representation, not the negotiation: the reader asked in a
    // language and the document they get is in it.
    const response = await get(handlerWith(declaresFailure()), '/ar-eg/second');

    expect(response.headers.get('content-language')).toBe('ar-EG');
  });

  it('is not stored as though it were the address answering', async () => {
    const served = await get(handlerWith(rendersPage), '/en-us/second');
    const declared = await get(handlerWith(declaresFailure()), '/en-us/second');

    // The same address, one classification apart. Without this a content network holds the
    // maintenance page under the page's own key and goes on serving it after the deployment
    // recovers, which is the failure that outlives the outage.
    expect(served.headers.get('cache-control')).toBe(
      'public, max-age=600, must-revalidate',
    );
    expect(declared.headers.get('cache-control')).toBe('private, no-store');
    expect(declared.headers.get('vary')).toBeNull();
  });

  it('remembers the locale the reader was answered in', async () => {
    const response = await get(handlerWith(declaresFailure()), '/ar-eg/second');

    // The navigation was real and the locale settled, so the choice is recorded. A failure is a
    // reason to serve something else, not a reason to forget who asked.
    expect(response.headers.get('set-cookie')).toContain('atlas-locale=ar-EG');
  });
});

/**
 * A plain response is not a declaration, which is what makes the union backward compatible.
 */
describe('a renderer that declares nothing', () => {
  it('is unchanged by the arrival of the declaration', async () => {
    const response = await get(handlerWith(rendersPage), '/en-us/second');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=600, must-revalidate',
    );
  });

  it('does not have an accidental status read as a statement', async () => {
    // The case the specification names: an accidental failure and a deliberate one arriving as
    // the same value cannot be told apart, so an ordinary response's status is not consulted.
    const response = await get(
      handlerWith(() => new Response('<!doctype html>', { status: 500 })),
      '/en-us/second',
    );

    expect(response.status).toBe(200);
  });
});

/**
 * The narrow rule, at the one place the two sides can disagree.
 *
 * An application declaring maintenance does not know which addresses Atlas answered from the
 * status table, so the rule it can reason about is the one that leaves those addresses alone.
 */
describe('a declaration at an address Atlas did not serve', () => {
  it('does not displace the status Atlas resolved', async () => {
    const response = await get(handlerWith(declaresFailure()), '/en-us/absent');

    expect(response.status).toBe(404);
  });

  it('still supplies the body, which was never Atlas to decide', async () => {
    const response = await get(handlerWith(declaresFailure()), '/en-us/absent');

    expect(await response.text()).toContain('maintenance');
  });

  it('says so where a developer will see it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await get(handlerWith(declaresFailure()), '/en-us/absent');

    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] ?? [];
    expect(String(message)).toContain('503');
    expect(String(message)).toContain('404');
    expect(String(message)).toContain('/en-us/absent');
  });

  it('says it once, however many addresses arrive', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handler = handlerWith(declaresFailure());

    await get(handler, '/en-us/absent');
    await get(handler, '/en-us/also-absent');
    await get(handler, '/en-us/a-third');

    // Keyed on the pair of statuses, not on the address. The addresses are supplied by whoever
    // is asking and there is no end to them, so a record keyed on one is a record a request
    // decides the size of.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('is quiet in production', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';

    try {
      await get(handlerWith(declaresFailure()), '/en-us/absent');
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }

    expect(warn).not.toHaveBeenCalled();
  });

  it('is not reported when the declaration did travel, which is the control', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const response = await get(handlerWith(declaresFailure()), '/en-us/second');

    expect(response.status).toBe(503);
    expect(warn).not.toHaveBeenCalled();
  });
});
