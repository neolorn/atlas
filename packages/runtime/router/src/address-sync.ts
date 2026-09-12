import { Location, PlatformLocation } from '@angular/common';
import { DestroyRef, Injectable, inject } from '@angular/core';
import {
  NavigationEnd,
  NavigationSkipped,
  NavigationSkippedCode,
  Router,
} from '@angular/router';

/**
 * Keep the address bar spelling the current route in the committed locale.
 *
 * That sentence is the whole of it, and it is written as a predicate rather than as a list of
 * occasions because the occasions were the problem. This began as "move the address bar when the
 * locale changes", which is true and is not enough: a locale change is not the only way the address
 * and the locale come apart, and an answer shaped like a trigger can only ever fix the triggers
 * someone thought of.
 *
 * **What the trigger shape missed.** A `popstate` onto a history entry whose canonical route is the
 * one already active is skipped by the Router (`NavigationSkipped`, code
 * `IgnoredSameUrlNavigation`) and a skipped navigation never reaches `setBrowserUrl`, so nothing
 * writes the address (`@angular/router` 22.1.3, `_router-chunk.mjs:3804-3810` and `:4336`). The
 * entry it returned to was written before a locale change, in the previous language, and it stays
 * on screen while the page renders in the current one: an English page at an Arabic address, which
 * is the same incoherence a sub-path deployment produced from the other direction.
 *
 * It is narrow and it is real. Measured: the Router's own navigations cannot produce it, because a
 * locale switch replaces its history entry rather than pushing one, so no two adjacent entries
 * carry one canonical route. An application that pushes its own entry (a modal, a wizard step, a
 * filter state kept in history) makes two, and then a single Back is enough.
 *
 * **Three occasions, one question.** The predicate is asked when the locale commits, when a
 * navigation ends, and when one is skipped. On the second it is nearly always silent: the deferred
 * URL update already wrote the address before `NavigationEnd`, so the two agree and nothing
 * happens. That is the point of asking anyway: a check that is quiet when the machinery worked
 * costs nothing and does not have to be extended the next time some path does not write.
 *
 * `Location.replaceState` is the whole of the write, because it funnels through
 * `LocationStrategy.prepareExternalUrl`, which is already localizing and already mounting the
 * deployment's sub-path.
 *
 * One registration for the whole application. Nothing per route, nothing per page, no call site.
 */
@Injectable({ providedIn: 'root' })
export class LocalizedAddressSync {
  private readonly location = inject(Location);
  private readonly platformLocation = inject(PlatformLocation);
  private readonly router = inject(Router);

  constructor() {
    const subscription = this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        this.reconcile();
        return;
      }
      // One skip code, named. The other, `IgnoredByUrlHandlingStrategy`, is a deliberate statement
      // that an address is not the Router's to answer for, and rewriting it would be taking an
      // address its owner asked to keep. Atlas's own strategy processes every URL, so it cannot
      // arise from here, which is why this is written as the code it accepts rather than as the
      // absence of a case.
      if (
        event instanceof NavigationSkipped &&
        event.code === NavigationSkippedCode.IgnoredSameUrlNavigation
      ) {
        this.reconcile();
      }
    });
    inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
  }

  /**
   * Asked by the runtime's commit list, at the position a locale commit gives this step.
   *
   * Called rather than observed, because *when* the address moves is a property of the commit and
   * not of this service: it has to be settled before the head is projected and before a reader is
   * told the language changed, and an effect's turn comes when its service happened to be
   * constructed. See the list in `provideLocalization()`.
   */
  ɵreconcile(): void {
    this.reconcile();
  }

  /**
   * Write the address the current route and locale spell, when that is not what the browser shows.
   *
   * The comparison is against what the browser actually displays (`PlatformLocation`, raw)
   * rather than against `Location.path()`, which returns the delocalized internal path and would
   * compare the address to itself with the locale taken out of both sides.
   */
  private reconcile(): void {
    // Never before the Router has adopted the address it booted on. `router.url` is `/` until
    // initial navigation completes, so an unguarded call during startup replaces the visitor's
    // address with the root: a hard load of `/ar-eg/second` renders home.
    if (!this.router.navigated) return;
    // A navigation that asked not to change the address is not a disagreement to fix. The option
    // exists so an application can show one address while the Router holds another, and a check
    // that corrected it would make the feature stop working in a localized application only.
    if (
      this.router.lastSuccessfulNavigation()?.extras.skipLocationChange === true
    )
      return;
    const expected = this.location.prepareExternalUrl(this.router.url);
    const { pathname, search, hash } = this.platformLocation;
    if (expected === `${pathname}${search}${hash}`) return;
    // Three arguments, and the third is load-bearing. `Location.replaceState(path, query?, state?)`
    // defaults `state` to null, so the one-argument call erases the current history entry's state:
    // `{navigationId: 3, routerPageId: 2}` becomes null. `RouterScroller` keys its stored scroll
    // positions on `restoredState.navigationId` and emits `store[restoredId]` only on a popstate,
    // so an erased entry gives `restoredId = 0` and Back after a locale change restores [0, 0]
    // instead of where the reader was. Nothing reports it.
    //
    // `location.getState()` rather than `history.state`, which is a browser global and would throw
    // during server rendering.
    this.location.replaceState(this.router.url, '', this.location.getState());
  }
}
