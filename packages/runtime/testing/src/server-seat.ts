// A test asks an address and reads what was answered, with nothing to build and no socket to open.
//
// Section 12 of `specs/06-runtime-and-angular.spec.md` fixes what this is for: the status, the
// headers and the head of a response. None of the three is reachable from a component seat, because
// each is decided by the request handler rather than by the page, so an application that has only a
// component seat writes a server of its own, builds it, starts it on a port, and reads its answers
// back over a socket.
//
// It answers through `createLocaleRequestHandler`, the handler a deployment installs. What the
// handler decided is reported by the handler rather than worked out again here, because a seat that
// re-derived the status table, the cacheability, or section 5's narrow rule would agree with the
// deployment until one of them changed.

import {
  createLocaleRequestHandler,
  toWebRequest,
  type LocaleRequestHandler,
  type LocaleRequestHandlerOptions,
  type ɵAnsweredRequest,
} from '@neolorn/atlas/http';
import type {
  PageOutcomeDeclaration,
  RouteResolution,
} from '@neolorn/atlas/core';

/**
 * One `<link>` the answered head carried.
 *
 * `hreflang` is present on an alternate and absent on a canonical, so it is the field that tells a
 * cluster entry from the page's own address.
 */
export interface AnsweredLink {
  /** The relationship, as written. */
  readonly rel: string;
  /** Where it points, as written, which for a localized page is an absolute address. */
  readonly href: string;
  /** The locale this link is for, on the links that state one. */
  readonly hreflang: string | undefined;
}

/**
 * The head of the document that was answered, read as fields rather than as text.
 *
 * Read from the response body rather than from a DOM, so a test needs neither a browser nor a
 * document. Everything inside `<head>` is scanned except script content, style content and
 * comments; a document with no `<head>` is scanned whole, which is what a fragment is.
 */
export interface AnsweredHead {
  /** What the tab and the search result say, with its surrounding whitespace removed. */
  readonly title: string | undefined;
  /** The `lang` of the root element, which is the language the document states it is in. */
  readonly lang: string | undefined;
  /** The `dir` of the root element. */
  readonly dir: string | undefined;
  /** Every `<meta name>`, by name. A repeated name answers with the last one written. */
  readonly meta: Readonly<Record<string, string>>;
  /** Every `<meta property>`, by property, which is where the social card is written. */
  readonly properties: Readonly<Record<string, string>>;
  /** Every `<link>` that carries a relationship and an address, in document order. */
  readonly links: readonly AnsweredLink[];
  /** The canonical address, or the first of them where a page wrongly published two. */
  readonly canonical: string | undefined;
  /** The `hreflang` cluster: every alternate link that names a locale. */
  readonly alternates: readonly AnsweredLink[];
  /** The page's own summary of itself. */
  readonly description: string | undefined;
  /** What the page tells a crawler about itself, which is separate from the `X-Robots-Tag`. */
  readonly robots: string | undefined;
}

/**
 * An outcome a page or a renderer declared for this render, and whether it decided the response.
 *
 * `carried` is section 5's narrow rule as the handler applied it: a declaration stands where the
 * address resolved to a route, and the status table stands everywhere else. A response cannot say
 * which of the two answered it, because a declared absence and a refused address are both 404.
 */
export interface AnsweredPageOutcome {
  /** What was stated: an absence, a permanent removal, or an operational failure. */
  readonly declared: PageOutcomeDeclaration;
  /** Whether the response's status and caching came from that declaration. */
  readonly carried: boolean;
}

/** What one address answered, and what the handler decided on the way to answering it. */
export interface AnsweredAddress {
  /** The response itself, for anything the fields below do not cover. */
  readonly response: Response;
  /** The status sent. */
  readonly status: number;
  /** The headers sent, including `set-cookie`, which `getSetCookie()` reads as a list. */
  readonly headers: Headers;
  /** The body as text, empty for the outcomes answered without one. */
  readonly body: string;
  /** The head of that body. */
  readonly head: AnsweredHead;
  /** What the address resolved to, including the outcomes that never reach a renderer. */
  readonly resolution: RouteResolution;
  /** The locale the renderer was told to draw in, absent where no renderer was called. */
  readonly locale: string | undefined;
  /** What the page or the renderer declared, absent where neither did. */
  readonly pageOutcome: AnsweredPageOutcome | undefined;
  /** Whether Atlas declined the address, which is a static asset or a locale-neutral root. */
  readonly declined: boolean;
}

/**
 * What the seat needs, which is what the deployment already passes to its own handler.
 *
 * Pass the deployment's own options object rather than writing a second one, so what a test asserts
 * is the configuration that ships. The cache lifetimes and the cookie policy in particular decide
 * every response's cacheability, and a seat configured with different ones answers differently from
 * the server it stands for.
 */
export interface LocalizedServerSeatOptions extends LocaleRequestHandlerOptions {
  /**
   * The origin a relative address is asked on, defaulting to `https://localhost`.
   *
   * Under a locale-host policy the host is what carries the locale, so name the origin here or ask
   * for absolute addresses.
   */
  readonly origin?: string;
}

/** The seat: it answers addresses through the handler and hands back what was answered. */
export interface LocalizedServerSeat {
  /** The handler itself, for a test that wants to hand it a request it built for other reasons. */
  readonly handler: LocaleRequestHandler;
  /**
   * Answers one address, given as a path or as an absolute address.
   *
   * The address travels as written. A `Request` parses and serializes the URL it is built from,
   * which resolves dot segments and rewrites a backslash, so an address asking for a traversal
   * would otherwise arrive repaired and be rendered rather than refused.
   */
  request(
    address: string,
    init?: AnsweredRequestInit,
  ): Promise<AnsweredAddress>;
  /**
   * Answers a request built by the caller.
   *
   * The request target is whatever the `Request` carries, which is the parsed form. Use it for a
   * method, a body, or headers that are easier to build as a request than as a list.
   */
  answer(request: Request): Promise<AnsweredAddress>;
}

/** The method and headers one asked address carries. */
export interface AnsweredRequestInit {
  /** Defaults to `GET`. The status table answers a preference-dependent entry by safe method. */
  readonly method?: string;
  /** The request headers, which is where `accept-language` and `cookie` go. */
  readonly headers?: HeadersInit;
}

const DEFAULT_ORIGIN = 'https://localhost';
const ABSOLUTE = /^[a-z][a-z0-9+.-]*:\/\//iu;

/**
 * Builds a seat over the handler this deployment installs.
 *
 * ```ts
 * const seat = createLocalizedServerSeat({ ...serverOptions, origin: 'https://example.com' });
 * const answered = await seat.request('/en-us/articles/missing');
 * expect(answered.status).toBe(404);
 * expect(answered.pageOutcome?.declared.outcome).toBe('absent');
 * ```
 *
 * It opens no socket, loads no build output, and needs no document. The renderer is the
 * deployment's own, so what the head says is what the application wrote into it.
 */
export function createLocalizedServerSeat(
  options: LocalizedServerSeatOptions,
): LocalizedServerSeat {
  const origin = options.origin ?? DEFAULT_ORIGIN;
  const answers = new WeakMap<Request, ɵAnsweredRequest>();
  const handler = createLocaleRequestHandler({
    ...options,
    ɵobserve: (answered) => {
      answers.set(answered.request, answered);
    },
  });

  const answer = async (request: Request): Promise<AnsweredAddress> => {
    const response = await handler(request);
    const observed = answers.get(request);
    if (observed === undefined) {
      throw new Error('Atlas server seat invariant failed.');
    }
    const body = await response.clone().text();
    return Object.freeze({
      response,
      status: response.status,
      headers: response.headers,
      body,
      head: answeredHead(body),
      resolution: observed.resolution,
      locale: observed.locale,
      pageOutcome:
        observed.declared === undefined
          ? undefined
          : Object.freeze({
              declared: observed.declared,
              carried: observed.carried,
            }),
      declined: observed.declined,
    });
  };

  return Object.freeze({
    handler,
    answer,
    request: (address: string, init: AnsweredRequestInit = {}) => {
      const headers: Record<string, string> = {};
      for (const [name, value] of new Headers(init.headers)) {
        headers[name] = value;
      }
      const asked = askedOn(address, origin);
      return answer(
        toWebRequest(
          { method: init.method, url: asked.target, headers },
          asked.origin,
        ),
      );
    },
  });
}

/**
 * Splits an asked address into the origin it is asked on and the target as written.
 *
 * Split by hand rather than through `URL`, because parsing is the step that repairs a target and
 * the target is the thing under test.
 */
function askedOn(
  address: string,
  origin: string,
): { readonly origin: string; readonly target: string } {
  if (!ABSOLUTE.test(address)) return { origin, target: address };
  const authority = address.indexOf('/', address.indexOf('://') + 3);
  if (authority === -1) return { origin: address, target: '/' };
  return {
    origin: address.slice(0, authority),
    target: address.slice(authority),
  };
}

const ROOT_ELEMENT = /<html\b([^>]*)>/iu;
const HEAD_ELEMENT = /<head\b[^>]*>([\s\S]*?)<\/head>/iu;
const TITLE_ELEMENT = /<title\b[^>]*>([\s\S]*?)<\/title>/iu;
const NOT_METADATA =
  /<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/giu;
const METADATA_ELEMENT = /<(meta|link)\b([^>]*?)\/?>/giu;
const ATTRIBUTE =
  /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
const CHARACTER_REFERENCE =
  /&(?:#[Xx]([0-9A-Fa-f]+)|#(\d+)|(amp|lt|gt|quot|apos|nbsp));/gu;
const NAMED_CHARACTERS: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
});

/**
 * Reads the head of an answered document.
 *
 * Exported because the head is the half of a response a test asks the most of, and a consumer that
 * obtained its HTML some other way should not have to build a seat to read it.
 */
export function answeredHead(document: string): AnsweredHead {
  const root = attributesOf(ROOT_ELEMENT.exec(document)?.[1] ?? '');
  const head = HEAD_ELEMENT.exec(document)?.[1] ?? document;
  // Script and style content is text, not markup, and a comment is neither. A canonical link
  // written inside any of the three is not in the head, and a page that carries JSON-LD carries
  // enough angle brackets inside a script to be read as several.
  const scanned = head.replace(NOT_METADATA, '');
  const meta: Record<string, string> = {};
  const properties: Record<string, string> = {};
  const links: AnsweredLink[] = [];
  for (const element of scanned.matchAll(METADATA_ELEMENT)) {
    const attributes = attributesOf(element[2] ?? '');
    if ((element[1] ?? '').toLowerCase() === 'meta') {
      const content = attributes['content'] ?? '';
      const name = attributes['name'];
      const property = attributes['property'];
      if (name !== undefined) meta[name] = content;
      if (property !== undefined) properties[property] = content;
      continue;
    }
    const rel = attributes['rel'];
    const href = attributes['href'];
    if (rel === undefined || href === undefined) continue;
    links.push(Object.freeze({ rel, href, hreflang: attributes['hreflang'] }));
  }
  const title = TITLE_ELEMENT.exec(scanned)?.[1];
  return Object.freeze({
    title: title === undefined ? undefined : decode(title).trim(),
    lang: root['lang'],
    dir: root['dir'],
    meta: Object.freeze(meta),
    properties: Object.freeze(properties),
    links: Object.freeze(links),
    canonical: links.find((link) => link.rel.toLowerCase() === 'canonical')
      ?.href,
    alternates: Object.freeze(
      links.filter(
        (link) =>
          link.rel.toLowerCase() === 'alternate' && link.hreflang !== undefined,
      ),
    ),
    description: meta['description'],
    robots: meta['robots'],
  });
}

/** The attributes of one start tag, lower-cased by name, with their values decoded. */
function attributesOf(source: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const attribute of source.matchAll(ATTRIBUTE)) {
    const name = (attribute[1] ?? '').toLowerCase();
    if (name === '') continue;
    found[name] = decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
  }
  return found;
}

/**
 * Turns the character references a serializer writes back into the text that was set.
 *
 * A title set to `Ali & Co` reaches the response as `Ali &amp; Co`, and an assertion written
 * against the string the application passed would fail on the escaping rather than on the title.
 */
function decode(text: string): string {
  return text.replace(
    CHARACTER_REFERENCE,
    (
      reference,
      hex: string | undefined,
      decimal: string | undefined,
      name: string | undefined,
    ) => {
      const point =
        hex !== undefined
          ? Number.parseInt(hex, 16)
          : decimal !== undefined
            ? Number.parseInt(decimal, 10)
            : undefined;
      if (point !== undefined) {
        return Number.isInteger(point) && point >= 0 && point <= 0x10_ffff
          ? String.fromCodePoint(point)
          : reference;
      }
      return NAMED_CHARACTERS[(name ?? '').toLowerCase()] ?? reference;
    },
  );
}
