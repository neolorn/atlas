import type { LocaleRequestHandler } from './handler';
import { rememberRawTarget } from './raw-target';

/**
 * The Node adapter, and the only file here that knows Node exists.
 *
 * The handler itself is written against Fetch `Request` and `Response`, which is what a worker, a
 * Lambda and Fastify already speak, and what lets the handler be exercised without a socket, which
 * is what makes the single-origin check possible at all. Node's `IncomingMessage`/`ServerResponse`
 * are the odd pair out, so they are adapted here rather than being the shape everything else has to
 * accommodate.
 *
 * **The Node types are declared structurally rather than imported from `node:http`.** Importing them
 * would put `@types/node` into the compilation of a published library and give this entry point a
 * platform dependency it does not have at runtime: nothing here calls a Node API. Declaring only
 * the members actually touched also states the coupling exactly: three properties, three methods.
 * Node's own `IncomingMessage` and `ServerResponse` satisfy these by structure, so a consumer passes
 * them straight in with no cast.
 */
/** The three things read off an incoming Node request. Node's `IncomingMessage` satisfies it. */
export interface NodeRequestLike {
  /** The request method, defaulting to `GET` when the server did not set one. */
  readonly method?: string | undefined;
  /** The request target, which is a path and query rather than an absolute address. */
  readonly url?: string | undefined;
  /**
   * The request headers, lower-cased, with a repeated header carried as a list.
   *
   * `accept-language`, `cookie` and the `sec-fetch` family are the ones Atlas reads.
   */
  readonly headers: Readonly<
    Record<string, string | readonly string[] | undefined>
  >;
}

/** The four things written to an outgoing Node response. Node's `ServerResponse` satisfies it. */
export interface NodeResponseLike {
  /** Set before the body is written, and after the headers. */
  statusCode: number;
  /** Takes a list for `Set-Cookie`, which is the one header that may appear more than once. */
  setHeader(name: string, value: number | string | readonly string[]): unknown;
  /** Takes one chunk of the body. Called once per chunk the response stream yields. */
  write(chunk: Uint8Array): unknown;
  /** Ends the response. Called once, after the last chunk or instead of any. */
  end(): unknown;
}

/**
 * Turns an incoming Node request into the Fetch `Request` the handler is written against.
 *
 * Takes the message and the origin the request arrived on. The origin is required rather than
 * derived from the `Host` header, because that header is client-controlled and the resulting
 * address decides what Atlas treats as same-origin.
 *
 * The target is recorded as it arrived. Building the request resolves dot segments and rewrites a
 * backslash, so a structurally unsafe target would otherwise reach the handler as the address it
 * was aiming at, repaired, and be rendered rather than refused.
 */
export function toWebRequest(
  message: NodeRequestLike,
  origin: string,
): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    if (typeof value === 'string') headers.set(name, value);
    else for (const entry of value) headers.append(name, entry);
  }
  const method = message.method ?? 'GET';
  const target = message.url ?? '/';
  const request = new Request(new URL(target, origin), { method, headers });
  rememberRawTarget(request, target);
  return request;
}

/**
 * Writes a Fetch `Response` onto a Node response.
 *
 * `Set-Cookie` is the one header that may legitimately appear more than once, and it is the one this
 * handler emits, so it is taken through `getSetCookie()` rather than through the joined value:
 * joining two cookies with a comma produces one header that sets neither.
 */
export async function writeNodeResponse(
  response: Response,
  target: NodeResponseLike,
): Promise<void> {
  const cookies = response.headers.getSetCookie();
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() === 'set-cookie') continue;
    target.setHeader(name, value);
  }
  if (cookies.length > 0) target.setHeader('set-cookie', cookies);
  target.statusCode = response.status;
  if (response.body === null) {
    target.end();
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    target.write(chunk.value);
  }
  target.end();
}

/** The handler as a Node request listener, for a consumer whose server speaks Node and not Fetch. */
export function toNodeListener(
  handler: LocaleRequestHandler,
  options: { readonly origin?: string } = {},
): (message: NodeRequestLike, target: NodeResponseLike) => Promise<void> {
  return async (message, target) => {
    const host = message.headers['host'];
    const origin =
      options.origin ??
      `http://${typeof host === 'string' ? host : 'localhost'}`;
    await writeNodeResponse(
      await handler(toWebRequest(message, origin)),
      target,
    );
  };
}
