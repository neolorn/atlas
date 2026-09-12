import { Injectable, inject, isDevMode, signal } from '@angular/core';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  Router,
} from '@angular/router';
import type { LocalizedParameterSpellings } from '@neolorn/atlas';

/**
 * The per-locale spellings of the current page's route parameters, declared by the code that
 * loaded the record.
 *
 * Atlas builds every localized address through `RouteParameterCodec.serialize`, which is
 * synchronous. That is right for a parameter whose spelling is a function of its value (an
 * integer, an identifier, a slug from a fixed table) and it cannot answer for one held in a
 * database, because the answer is a fetch. So the fact is supplied by whoever can observe it: the
 * resolver or component that already loaded the record knows the article's Arabic slug, and
 * declares it.
 *
 * ```ts
 * const article = await this.articles.load(slug);
 * this.parameters.declare({ articleSlug: article.slugs });
 * ```
 *
 * From there Atlas uses it for the canonical URL, the `hreflang` alternates, the Open Graph
 * alternates and the address the locale switcher moves to.
 *
 * **A declaration belongs to one navigation and cannot be read by another.** This is the whole
 * reason the service exists rather than a settable field. The obvious shape, a mutable record of
 * per-locale parameters, carries a trap that is documented rather than prevented in the
 * framework Atlas took this shape from: parameters are not reset on navigation, so moving between
 * two routes that share a parameter name serves the previous page's slugs on the new page, in the
 * head, and Google is told that two different articles are translations of each other. Here a
 * declaration is stamped with the navigation that made it: `NavigationEnd` replaces the committed
 * declaration outright rather than merging into it, and a cancelled navigation's declaration is
 * discarded. There is no sequence of calls that lets one page read another's.
 *
 * Declaring after the page has loaded is the expected case, not a special one: the fetch that
 * produces the slugs finishes after activation. Atlas re-projects the document when a declaration
 * arrives, so the head is corrected rather than left as it was built.
 */
@Injectable({ providedIn: 'root' })
export class LocalizedRouteParameters {
  private readonly router = inject(Router);
  /** Declared while a navigation is in flight, keyed by that navigation's id. */
  private readonly staged = new Map<number, LocalizedParameterSpellings>();
  /**
   * The declaration for the page currently on screen, and the navigation that put it there.
   *
   * A signal because a late declaration has to move the head. It carries the id so that a reader
   * asking about a specific navigation cannot be handed another one's answer.
   */
  private readonly committed = signal<
    | {
        readonly navigationId: number;
        readonly spellings: LocalizedParameterSpellings;
      }
    | undefined
  >(undefined);
  private lastCommittedId: number | undefined;

  constructor() {
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        // Replaced, never merged. This one line is what makes the stale-parameter trap
        // unrepresentable: whatever the previous page declared stops being readable the moment
        // another page commits, including when the new page declares nothing at all.
        const spellings = this.staged.get(event.id);
        this.staged.clear();
        this.lastCommittedId = event.id;
        this.committed.set(
          spellings === undefined
            ? undefined
            : { navigationId: event.id, spellings },
        );
        return;
      }
      if (
        event instanceof NavigationCancel ||
        event instanceof NavigationError
      ) {
        // Cleanup, and stated as cleanup rather than as the safety property. Correctness comes
        // from the line above: navigation ids never repeat, so a declaration staged for a
        // navigation that never arrived could not have been read by another page even if it were
        // left here, and the next `NavigationEnd` clears it regardless. What this line buys is
        // that an application whose navigations are cancelled repeatedly does not accumulate them
        // until one finally succeeds.
        //
        // The committed declaration is untouched, because the reader is untouched: a cancelled
        // navigation leaves the previous page on screen and that page's slugs are still correct.
        this.staged.delete(event.id);
      }
    });
  }

  /**
   * Declare this page's parameter spellings in the locales it can be read in.
   *
   * Keyed parameter name, then locale: `{ articleSlug: { 'ar-EG': 'دليل-أطلس' } }`. Locales the
   * record has no spelling for are omitted rather than guessed: an omitted locale drops out of
   * the alternates, which is the honest claim, and a guessed one is an `hreflang` link to an
   * address that does not resolve.
   *
   * Calling twice within one navigation merges per parameter, so two resolvers can each declare
   * the parameter they loaded. Across navigations nothing merges.
   */
  declare(spellings: LocalizedParameterSpellings): void {
    const inflight = this.router.getCurrentNavigation()?.id;
    if (inflight !== undefined) {
      this.staged.set(inflight, merge(this.staged.get(inflight), spellings));
      return;
    }
    const navigationId = this.lastCommittedId;
    if (navigationId === undefined) {
      // No navigation has committed and none is in flight, so there is no page for this to
      // describe. Reported rather than stored: storing it would attach it to whichever page
      // happened to load first, which is the trap this class exists to prevent.
      if (isDevMode()) {
        console.warn(
          '[Atlas] LocalizedRouteParameters.declare() was called before any navigation completed, so there is no page for the declaration to belong to and it was discarded. Declare from a route resolver, a guard, or a component of the page the parameters describe.',
        );
      }
      return;
    }
    const current = this.committed();
    this.committed.set({
      navigationId,
      spellings: merge(
        current?.navigationId === navigationId ? current.spellings : undefined,
        spellings,
      ),
    });
  }

  /**
   * What the page on screen declared, or what the navigation in flight has declared so far.
   *
   * The in-flight answer is the one that matters for the address bar. With `urlUpdateStrategy:
   * 'deferred'` the Router writes the URL at the end of a successful navigation, which is before
   * this class has seen `NavigationEnd`, so a reader that only ever saw the committed value
   * would spell the incoming page's address with the outgoing page's slugs.
   */
  current(): LocalizedParameterSpellings | undefined {
    const inflight = this.router.getCurrentNavigation()?.id;
    if (inflight !== undefined) return this.staged.get(inflight);
    return this.committed()?.spellings;
  }

  /**
   * The declaration belonging to one specific navigation, and no other.
   *
   * Internal, and the reason it exists is ordering. Atlas projects the document from a context
   * that carries the navigation that produced it, and both this class and that projection are
   * driven by `NavigationEnd` on the same event stream, so asking for "the current declaration"
   * there would make the answer depend on which subscriber Angular happens to call first. Asking
   * by id has one answer whatever the order.
   */
  ɵforNavigation(
    navigationId: number,
  ): LocalizedParameterSpellings | undefined {
    // The signal is read first and unconditionally, so that an effect calling this tracks it
    // whatever the answer turns out to be. Reading it only after the map missed would leave an
    // effect that asked about a navigation with a staged declaration permanently undependent on
    // later ones, and a late declaration would then never move the head.
    const committed = this.committed();
    const staged = this.staged.get(navigationId);
    if (staged !== undefined) return staged;
    return committed?.navigationId === navigationId
      ? committed.spellings
      : undefined;
  }
}

function merge(
  base: LocalizedParameterSpellings | undefined,
  next: LocalizedParameterSpellings,
): LocalizedParameterSpellings {
  const merged: Record<string, Readonly<Record<string, string>>> = {
    ...(base ?? {}),
  };
  for (const [parameter, spellings] of Object.entries(next)) {
    merged[parameter] = Object.freeze({
      ...(merged[parameter] ?? {}),
      ...spellings,
    });
  }
  return Object.freeze(merged);
}
