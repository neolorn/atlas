/**
 * The HTTP layer: one request in, one response out, with no Angular anywhere in the graph.
 *
 * A secondary entry point rather than part of `@neolorn/atlas`, on the *environment* reason
 * `specs/02-packages-and-platform.spec.md` section 2 allows rather than the optional-peer reason the
 * other three sit on. It carries no peer at all, and that is precisely
 * what it demonstrates: every existing entry point throws `PlatformLocation needs the JIT compiler`
 * on import in plain Node, which makes all of them unusable in a worker, a Lambda, or any server
 * that is not the Angular one. This entry point loads where those cannot.
 *
 * **Not `/server`.** `/ssr` already exists and means Angular rendering, and a `/server` beside it
 * would not say which of the two carries the Angular integration. `/http` reads as the protocol
 * layer against `/ssr`'s rendering integration, which is what it is.
 *
 * **It calls `routeHttpDescriptor`; it does not reimplement it.** One classification computed in one
 * place. A handler that reimplemented the classification would pass every test written against the
 * handler while disagreeing with the descriptor, so the equivalence is asserted against the
 * descriptor rather than assumed, in `http-handler.test.ts`.
 */

export {
  createLocaleRequestHandler,
  declareOperationalFailure,
  declarePageOutcome,
  type DeclaredOperationalFailure,
  type DeclaredPageOutcome,
  type LocaleCookiePolicy,
  type LocaleRequestHandler,
  type LocaleRequestHandlerOptions,
  type LocaleRequestOutcome,
  type LocalizedRenderResult,
  type RenderableResolution,
  type LocaleRenderer,
} from './handler';

export {
  toNodeListener,
  toWebRequest,
  writeNodeResponse,
  type NodeRequestLike,
  type NodeResponseLike,
} from './node';
