import {
  APP_BASE_HREF,
  PathLocationStrategy,
  PlatformLocation,
} from '@angular/common';
import { Injector, inject } from '@angular/core';
import {
  Localization,
  toExternalPath,
  toInternalPath,
  withBasePath,
  withoutBasePath,
  type LocalizedAddressContext,
} from '@neolorn/atlas';

import { LocalizedRouteParameters } from './route-parameters.js';

/**
 * One strategy over a constant base href, implementing both halves of the translation.
 *
 * The base href stays constant, and that is settled rather than deferred. `Location` computes
 * `_basePath` once in its constructor and `path()` strips that frozen value, so a base href that
 * varied per locale would be read once and then be wrong. Angular's own i18n answer is a
 * build-time base href per locale; Atlas's is one build whose locale lives in the path.
 *
 * `RouterLink` never calls `prepareExternalUrl` (its click navigates the raw, unprepared tree)
 * and the design does not need it to. The click hands the Router a canonical address, which is a
 * real authored route, so it matches directly, and the history write that follows goes through
 * `pushState` and comes out localized.
 */
export class LocalizedLocationStrategy extends PathLocationStrategy {
  private readonly localization = inject(Localization);
  /**
   * Resolved on first use, and that is forced rather than chosen.
   *
   * This strategy is constructed from inside the Router's own dependency graph (`Router` needs
   * `Location`, which needs `LocationStrategy`) so naming anything here that needs the `Router`
   * closes the cycle, and Angular reports `NG0200` at bootstrap. Measured, not predicted: adding
   * `inject(LocalizedRouteParameters)` as a field failed six spec files that way.
   *
   * Deferring is sound rather than a way around the message. Nothing asks this strategy to prepare
   * an address until the Router is navigating, and by then the Router exists.
   */
  private readonly injector = inject(Injector);
  private parametersRef: LocalizedRouteParameters | undefined;
  private readonly context: LocalizedAddressContext;

  constructor(context: LocalizedAddressContext) {
    super(
      inject(PlatformLocation),
      inject(APP_BASE_HREF, { optional: true }) ?? undefined,
    );
    this.context = context;
  }

  override path(includeHash = false): string {
    return this.withBase(
      toInternalPath(this.withoutBase(super.path(includeHash)), this.context),
    );
  }

  /**
   * The declared spellings are read here as well as in the head, and for the same page.
   *
   * A route whose parameter is a loaded slug has no derivable spelling, so without the declaration
   * this writes the address the codec can produce, which after a locale switch is the previous
   * language's. The head would then carry one address for the page and the address bar another.
   */
  override prepareExternalUrl(internal: string): string {
    return super.prepareExternalUrl(
      toExternalPath(
        internal,
        this.activeLocale(),
        this.context,
        this.declaredSpellings(),
      ),
    );
  }

  private declaredSpellings(): ReturnType<LocalizedRouteParameters['current']> {
    this.parametersRef ??= this.injector.get(LocalizedRouteParameters);
    return this.parametersRef.current();
  }

  /** Read live on every call: the address bar has to speak whatever locale is committed now. */
  private activeLocale(): string {
    return (
      this.localization.snapshot()?.primaryLocale ??
      this.context.policy.defaultLocale
    );
  }

  private withoutBase(url: string): string {
    return withoutBasePath(url, this.getBaseHref());
  }

  private withBase(url: string): string {
    return withBasePath(url, this.getBaseHref());
  }
}
