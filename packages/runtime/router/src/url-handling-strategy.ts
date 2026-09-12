/**
 * The second entrance into presentation routing, and the reason it exists.
 *
 * `specs/07-routing-rendering-and-seo.spec.md` section 4 requires both entrances to delocalize
 * through one function: the location strategy for an address the browser supplies, this one for
 * an address the application hands the router. A route's guards, resolvers, data, title and
 * route-scoped providers are reached by whichever entrance was used, so an authorization
 * boundary that held on one of them and not the other would hold on neither.
 */

import { Injector, inject, isDevMode } from '@angular/core';
import {
  UrlHandlingStrategy,
  UrlSerializer,
  type UrlTree,
} from '@angular/router';
import { toInternalPath, type LocalizedAddressContext } from '@neolorn/atlas';

/**
 * The same delocalization the `LocationStrategy` performs, on the one path it cannot see.
 *
 * `LocalizedLocationStrategy.path()` reads a browser-supplied address and hands the Router the
 * canonical one, which is what makes every address the Router matches canonical: 4.2's invariant,
 * and the reason `path()` and `prepareExternalUrl()` are a symmetric pair. But `navigateByUrl` and
 * `router.navigate` never consult a `LocationStrategy`: `navigateByUrl` is `parseUrl` then
 * `urlHandlingStrategy.merge` then `scheduleNavigation`, so an application navigating to
 * `/ar-eg/second` by hand put a prefixed address in front of the matcher and the invariant held for
 * browser-driven navigation only. The locale branches (which exist to be *walked* by the prerender
 * scan, and carry only enough to look renderable to it) were then matched, and a route's
 * `canActivate`, `resolve`, `data` and `title` were silently absent on that path. An authorization
 * boundary that holds on one path and not the other is not a boundary.
 *
 * So this is not a second rule. `extract` runs on every navigation request
 * (`extractedUrl: this.urlHandlingStrategy.extract(request.rawUrl)`, and matching runs against that
 * value and no other) and it calls `toInternalPath`, the same function `path()` calls. A
 * browser-supplied address arrives here already canonical, so `extract` is an identity on it. One
 * rule, applied at both of the two doors into the matcher.
 *
 * `merge` stays Angular's own behaviour (the new part, whole) because what goes back to the
 * browser is `urlSerializer.serialize(merge(finalUrl, initialUrl))` handed to `setBrowserUrl`,
 * which funnels through `prepareExternalUrl` and re-adds the prefix. Rewriting the merge would
 * localize the address twice.
 *
 * `shouldProcessUrl` is unconditionally true. Returning false empties the router state and destroys
 * every active component, which is a migration facility for hybrid AngularJS applications and not
 * anything localization has an opinion about.
 */
export class LocalizedUrlHandlingStrategy extends UrlHandlingStrategy {
  /**
   * Resolved on first use, for the reason `LocalizedLocationStrategy` defers its own lookups: this
   * strategy is constructed inside the Router's dependency graph, so naming anything here that
   * needs the Router closes the cycle and Angular reports `NG0200` at bootstrap. Nothing asks a
   * strategy to extract an address until the Router is navigating, and by then it exists.
   */
  private readonly injector = inject(Injector);
  private serializerRef: UrlSerializer | undefined;
  private readonly context: LocalizedAddressContext;

  constructor(context: LocalizedAddressContext) {
    super();
    this.context = context;
  }

  override shouldProcessUrl(): boolean {
    return true;
  }

  override extract(url: UrlTree): UrlTree {
    const serializer = this.serializer();
    const supplied = serializer.serialize(url);
    const internal = toInternalPath(supplied, this.context);
    if (internal === supplied) return url;
    this.report(supplied, internal);
    return serializer.parse(internal);
  }

  override merge(newUrlPart: UrlTree, _rawUrl: UrlTree): UrlTree {
    return newUrlPart;
  }

  /**
   * The behaviour change, said out loud where the call was made.
   *
   * Delocalizing silently would be its own defect. `navigateByUrl('/ar-eg/x')` while `en-US` is
   * committed renders `/x` and displays `/en-us/x`: the locale in the argument is ignored, which is
   * right (changing locale is a switching operation, not a navigation) but a caller who wrote a
   * locale into an address and got a different one back has to be told, or they will write it
   * again.
   *
   * Reaching here at all is what identifies the call. A browser-supplied address was delocalized by
   * `path()` before the Router saw it, and a `RouterLink` click navigates the raw canonical tree,
   * so an address that still carries a prefix when it arrives here came from application code. That
   * is a fact about the one path rather than a guess about intent.
   *
   * Development only, and one line naming three things: the address as written, the canonical
   * address to write instead, and the operation that actually changes locale.
   */
  private report(supplied: string, internal: string): void {
    if (!isDevMode()) return;
    console.warn(
      `[Atlas] A navigation to ${JSON.stringify(supplied)} names a locale in the address. Atlas resolves it as ${JSON.stringify(internal)} and renders it in the locale that is committed now, so the locale in the address was ignored rather than applied. Navigate to the canonical address ${JSON.stringify(internal)}, and change locale with Localization.changeLocale(): switching locale is its own operation, and it moves the address bar for you.`,
    );
  }

  private serializer(): UrlSerializer {
    this.serializerRef ??= this.injector.get(UrlSerializer);
    return this.serializerRef;
  }
}
