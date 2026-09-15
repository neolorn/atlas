import {
  Injectable,
  PLATFORM_ID,
  REQUEST,
  inject,
  isDevMode,
  signal,
} from '@angular/core';
import { isPlatformServer } from '@angular/common';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  Router,
} from '@angular/router';
// From the core entry point by specifier, which is where the declaration channel lives and the
// only way this and the request handler hold one copy of it: a file reached relatively is compiled
// into the reaching bundle, and two copies of a `WeakMap` are two channels.
import {
  LocalizationError,
  ɵrememberPageOutcome,
  type PageOutcomeDeclaration,
} from '@neolorn/atlas/core';

/**
 * What this page turned out to be, declared by the code that discovered it.
 *
 * Routing decides what an address means from the address. Whether the article it names still
 * exists, whether it was taken down for good, and whether the load that would have produced it
 * failed are three facts no address states, and
 * `specs/07-routing-rendering-and-seo.spec.md` section 5 requires a release to supply a way to
 * state them. This is it.
 *
 * ```ts
 * const article = await this.articles.load(slug);
 * if (article === undefined) this.outcome.declare(pageAbsent());
 * ```
 *
 * On the server the declaration reaches the response: an absence is answered 404 and a removal 410,
 * both from section 5's own table, and a declared operational failure is answered with the status
 * the application named. In the browser there is no response to reach and Atlas does not invent
 * one; what the declaration governs there is the document, which stops claiming a canonical address
 * and stops being offered for indexing.
 *
 * **A declaration belongs to one navigation and cannot be read by another.** It is stamped with the
 * navigation that made it, a commit replaces the committed declaration outright including when the
 * arriving page declares nothing, and a cancelled navigation's declaration is discarded. Those are
 * the rules `LocalizedRouteParameters` already works under, and they are here for the same reason:
 * a declaration left readable across a navigation answers 404 for the page after the missing one.
 *
 * Declaring after activation is the expected case rather than a special one, because the fetch that
 * discovers the fact finishes after the page is on screen. Atlas re-projects the document when a
 * declaration arrives.
 */
@Injectable({ providedIn: 'root' })
export class LocalizedPageOutcome {
  private readonly router = inject(Router);
  /**
   * The request this render is answering, or `null` where there is none.
   *
   * `null` in the browser and during a build render, and those two mean different things: see
   * `declare` below, which answers them differently.
   */
  private readonly request = inject(REQUEST, { optional: true }) ?? null;
  private readonly onServer = isPlatformServer(inject(PLATFORM_ID));
  /** Declared while a navigation is in flight, keyed by that navigation's id. */
  private readonly staged = new Map<number, PageOutcomeDeclaration>();
  /**
   * The declaration for the page currently on screen, and the navigation that put it there.
   *
   * A signal because a late declaration has to move the head. It carries the id so that a reader
   * asking about a specific navigation cannot be handed another one's answer.
   */
  private readonly committed = signal<
    | {
        readonly navigationId: number;
        readonly declaration: PageOutcomeDeclaration;
      }
    | undefined
  >(undefined);
  private lastCommittedId: number | undefined;
  /** Whether the unreachable-channel warning has already been written in this process. */
  private reportedDetachedRequest = false;

  constructor() {
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        // Replaced, never merged, which is what makes a stale outcome unrepresentable: whatever
        // the previous page declared stops being readable the moment another page commits,
        // including when the new page declares nothing at all.
        const declaration = this.staged.get(event.id);
        this.staged.clear();
        this.lastCommittedId = event.id;
        this.committed.set(
          declaration === undefined
            ? undefined
            : { navigationId: event.id, declaration },
        );
        return;
      }
      if (
        event instanceof NavigationCancel ||
        event instanceof NavigationError
      ) {
        // Cleanup rather than the safety property. Navigation ids never repeat, so a declaration
        // staged for a navigation that never arrived could not be read by another page even if it
        // stayed here, and the next commit clears it regardless. What this buys is that an
        // application whose navigations are cancelled repeatedly does not accumulate them.
        this.staged.delete(event.id);
      }
    });
  }

  /**
   * State what this page turned out to be.
   *
   * Calling twice within one navigation keeps the last call, because the three outcomes are
   * alternatives rather than parts of one answer and merging them has no meaning.
   *
   * Throws during a build render. A prerendered page has no request to answer, and both arms
   * describe a page the build cannot write: an absence says the page the build was told to render
   * does not exist, and an operational failure says the render meant to produce it did not
   * succeed. A file written from either is served afterwards as a successful page with no status
   * left to say otherwise, so section 5 requires the build to fail instead.
   */
  declare(declaration: PageOutcomeDeclaration): void {
    if (this.onServer && this.request === null) {
      throw new LocalizationError({
        code: 'route-unavailable',
        outcome: 'operational-failure',
        message: `A page declared ${describe(declaration)} while rendering ahead of a request, so there is no response for it to reach and the file this render would write would be served as a successful page. Render this route on demand instead of prerendering it, or resolve the outcome before the build.`,
      });
    }
    this.stamp(declaration);
    if (this.request === null) return;
    if (!ɵrememberPageOutcome(this.request, declaration)) {
      this.reportDetachedRequest(declaration);
    }
  }

  /** What the page on screen declared, or what the navigation in flight has declared so far. */
  current(): PageOutcomeDeclaration | undefined {
    const inflight = this.router.getCurrentNavigation()?.id;
    if (inflight !== undefined) return this.staged.get(inflight);
    return this.committed()?.declaration;
  }

  /**
   * The declaration belonging to one specific navigation, and no other.
   *
   * Internal, and it exists for the ordering reason `LocalizedRouteParameters.ɵforNavigation`
   * states: this class and the document projection are driven by the same event stream, so asking
   * for the current declaration there would make the answer depend on subscriber order.
   */
  ɵforNavigation(navigationId: number): PageOutcomeDeclaration | undefined {
    // Read first and unconditionally, so an effect calling this tracks the signal whatever the
    // answer turns out to be. Reading it only after the map missed would leave an effect that
    // asked about a navigation with a staged declaration independent of later ones, and a late
    // declaration would then never move the head.
    const committed = this.committed();
    const staged = this.staged.get(navigationId);
    if (staged !== undefined) return staged;
    return committed?.navigationId === navigationId
      ? committed.declaration
      : undefined;
  }

  private stamp(declaration: PageOutcomeDeclaration): void {
    const inflight = this.router.getCurrentNavigation()?.id;
    if (inflight !== undefined) {
      this.staged.set(inflight, declaration);
      return;
    }
    const navigationId = this.lastCommittedId;
    if (navigationId === undefined) {
      // No navigation has committed and none is in flight, so there is no page for this to
      // describe. Reported rather than stored: storing it would attach it to whichever page
      // happened to load first.
      if (isDevMode()) {
        console.warn(
          '[Atlas] LocalizedPageOutcome.declare() was called before any navigation completed, so there is no page for the declaration to belong to and it was discarded. Declare from a route resolver, a guard, or a component of the page the outcome describes.',
        );
      }
      return;
    }
    this.committed.set({ navigationId, declaration });
  }

  /**
   * Says once that the declaration had nowhere to go.
   *
   * The request in this injector is not the one the handler is holding, which happens when
   * something between the two replaces it. Nothing downstream can detect that on its own: a render
   * whose declaration never arrived produces the same response as one that declared nothing, and
   * only the first is a wiring fault. So it is said here, once, where the fault is visible.
   */
  private reportDetachedRequest(declaration: PageOutcomeDeclaration): void {
    if (!isDevMode()) return;
    if (this.reportedDetachedRequest) return;
    this.reportedDetachedRequest = true;
    console.warn(
      `[Atlas] A page declared ${describe(declaration)}, and the request this render was given is not the one the Atlas request handler is answering, so the declaration cannot reach the response and the address's own status was sent instead. Pass the request the handler received to the render rather than a copy of it.`,
    );
  }
}

function describe(declaration: PageOutcomeDeclaration): string {
  switch (declaration.outcome) {
    case 'absent':
      return 'an absent entity';
    case 'gone':
      return 'a permanent removal';
    case 'operational-failure':
      return `an operational failure with status ${declaration.status}`;
  }
}
