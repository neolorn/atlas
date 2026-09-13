/**
 * The request target as it arrived, kept beside the `Request` built from it.
 *
 * A Fetch `Request` cannot carry one. Its URL is parsed and serialized as the request is
 * constructed, and that resolves dot segments and rewrites a backslash, so
 * `/en/%2e%2e/%2e%2e/etc/passwd` reaches a handler written against a `Request` as `/etc/passwd`:
 * the address the traversal was aiming at, repaired, with nothing left to classify.
 * `specs/07-routing-rendering-and-seo.spec.md` section 4 says an Atlas release MUST NOT repair a
 * structurally unsafe target, and section 5 answers one with 400 before presentation routing. The
 * classifier therefore has to be given what arrived rather than what a URL made of it.
 *
 * Kept in a `WeakMap` keyed by the request rather than in a header. A header is observable, a
 * client can send one, and it would reach a renderer as though it had arrived with the request.
 * The entry lives exactly as long as the request object and is collected with it.
 *
 * A `Request` this adapter did not build has no entry, and the handler falls back to the URL's own
 * path. That is the same conclusion it reached before and it is the honest one: a consumer holding
 * only a `Request` never had the raw target either, and nothing here can invent it.
 */
const rawTargets = new WeakMap<Request, string>();

/** Records what arrived, called by the adapter that built the request from it. */
export function rememberRawTarget(request: Request, target: string): void {
  rawTargets.set(request, target);
}

/** What arrived, or `undefined` for a request this entry point did not build. */
export function rawTargetOf(request: Request): string | undefined {
  return rawTargets.get(request);
}
