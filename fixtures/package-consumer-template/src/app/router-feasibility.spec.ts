import { Location } from '@angular/common';
import { provideLocationMocks } from '@angular/common/testing';
import { Component, Injectable, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TestBed } from '@angular/core/testing';
import {
  ActivationEnd,
  ActivationStart,
  ActivatedRoute,
  NavigationEnd,
  type ResolveFn,
  ResolveEnd,
  ResolveStart,
  Router,
  type Routes,
  provideRouter,
  withRouterConfig,
} from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { map } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

interface PreparationPlan {
  readonly started: Deferred<void>;
  readonly ready: Deferred<string>;
}

interface PlannedPreparation {
  readonly started: Promise<void>;
  complete(value: string): void;
}

@Injectable()
class RouterProbe {
  readonly activations: string[] = [];

  private readonly plans = new Map<string, PreparationPlan>();

  plan(id: string): PlannedPreparation {
    if (this.plans.has(id)) {
      throw new Error(`Preparation ${id} is already planned.`);
    }

    const started = createDeferred<void>();
    const ready = createDeferred<string>();

    this.plans.set(id, { started, ready });

    return {
      started: started.promise,
      complete: (value: string) => ready.resolve(value),
    };
  }

  prepare(id: string): Promise<string> {
    const plan = this.plans.get(id);

    if (plan === undefined) {
      throw new Error(`Preparation ${id} was not planned by the test.`);
    }

    plan.started.resolve(undefined);
    return plan.ready.promise;
  }

  recordActivation(id: string): void {
    this.activations.push(id);
  }
}

@Component({
  selector: 'atlas-feature-stable-view',
  standalone: true,
  template: '<p data-view="stable">stable view</p>',
})
class StableView {}

@Component({
  selector: 'atlas-feature-prepared-view',
  standalone: true,
  template: `
    <p data-view="prepared">prepared {{ id() }}: {{ prepared() }}</p>
  `,
})
class PreparedView {
  private readonly route = inject(ActivatedRoute);
  private readonly probe = inject(RouterProbe);

  protected readonly id = toSignal(
    this.route.paramMap.pipe(
      map((parameters) => parameters.get('id') ?? 'missing'),
    ),
    { initialValue: this.route.snapshot.paramMap.get('id') ?? 'missing' },
  );
  protected readonly prepared = toSignal(
    this.route.data.pipe(map((data) => String(data['prepared']))),
    { initialValue: String(this.route.snapshot.data['prepared']) },
  );

  constructor() {
    this.probe.recordActivation(this.id());
  }
}

@Component({
  selector: 'atlas-feature-failed-view',
  standalone: true,
  template: '<p data-view="failed">this view must never activate</p>',
})
class FailedView {}

const preparationResolver: ResolveFn<string> = (route) => {
  const id = route.paramMap.get('id');

  if (id === null) {
    throw new Error('The prepared route requires an id.');
  }

  return inject(RouterProbe).prepare(id);
};

const failedResolver: ResolveFn<never> = () => {
  throw new Error('intentional router feasibility failure');
};

const routes: Routes = [
  {
    path: 'stable',
    component: StableView,
  },
  {
    path: 'prepared/:id',
    component: PreparedView,
    resolve: {
      prepared: preparationResolver,
    },
  },
  {
    path: 'failed',
    component: FailedView,
    resolve: {
      failure: failedResolver,
    },
  },
  {
    path: '',
    pathMatch: 'full',
    redirectTo: 'stable',
  },
];

function renderedText(harness: RouterTestingHarness): string {
  harness.detectChanges();

  return (
    harness.routeNativeElement?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  );
}

describe('Angular 22 public Router feasibility', () => {
  let harness: RouterTestingHarness;
  let router: Router;
  let location: Location;
  let probe: RouterProbe;
  let publicEvents: string[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [
        RouterProbe,
        provideRouter(
          routes,
          withRouterConfig({
            urlUpdateStrategy: 'deferred',
            canceledNavigationResolution: 'computed',
          }),
        ),
        provideLocationMocks(),
      ],
    }).compileComponents();

    router = TestBed.inject(Router);
    location = TestBed.inject(Location);
    probe = TestBed.inject(RouterProbe);
    publicEvents = [];
    router.events.subscribe((event) => {
      if (event instanceof ResolveStart) {
        publicEvents.push('resolve-start');
      } else if (event instanceof ResolveEnd) {
        publicEvents.push('resolve-end');
      } else if (event instanceof ActivationStart) {
        publicEvents.push('activation-start');
      } else if (event instanceof ActivationEnd) {
        publicEvents.push('activation-end');
      } else if (event instanceof NavigationEnd) {
        publicEvents.push('navigation-end');
      }
    });
    harness = await RouterTestingHarness.create('/stable');
    publicEvents.length = 0;

    expect(router.url).toBe('/stable');
    expect(location.path()).toBe('/stable');
    expect(renderedText(harness)).toContain('stable view');
  });

  it('retains the prior URL and view while the destination resolver prepares', async () => {
    const priorElement = harness.routeNativeElement;
    const target = probe.plan('one');

    const navigation = router.navigateByUrl('/prepared/one');
    await target.started;

    expect(router.url).toBe('/stable');
    expect(location.path()).toBe('/stable');
    expect(harness.routeNativeElement).toBe(priorElement);
    expect(renderedText(harness)).toContain('stable view');
    expect(probe.activations).toEqual([]);

    target.complete('ready-one');

    await expect(navigation).resolves.toBe(true);

    expect(router.url).toBe('/prepared/one');
    expect(location.path()).toBe('/prepared/one');
    expect(renderedText(harness)).toContain('prepared one: ready-one');
    expect(probe.activations).toEqual(['one']);
    expect(publicEvents).toEqual([
      'activation-start',
      'resolve-start',
      'resolve-end',
      'activation-end',
      'navigation-end',
    ]);
  });

  it('lets the latest intent win and ignores a superseded resolver', async () => {
    const slow = probe.plan('slow');
    const fast = probe.plan('fast');

    const slowNavigation = router.navigateByUrl('/prepared/slow');
    await slow.started;

    const fastNavigation = router.navigateByUrl('/prepared/fast');
    await fast.started;

    await expect(slowNavigation).resolves.toBe(false);
    expect(router.url).toBe('/stable');
    expect(location.path()).toBe('/stable');
    expect(renderedText(harness)).toContain('stable view');

    fast.complete('ready-fast');
    await expect(fastNavigation).resolves.toBe(true);

    expect(router.url).toBe('/prepared/fast');
    expect(location.path()).toBe('/prepared/fast');
    expect(renderedText(harness)).toContain('prepared fast: ready-fast');
    expect(probe.activations).toEqual(['fast']);

    slow.complete('late-slow');
    await Promise.resolve();
    await Promise.resolve();

    expect(router.url).toBe('/prepared/fast');
    expect(location.path()).toBe('/prepared/fast');
    expect(probe.activations).toEqual(['fast']);
  });

  it('updates a prepared snapshot coherently when Angular reuses the route component', async () => {
    const first = probe.plan('reuse-first');
    const firstNavigation = router.navigateByUrl('/prepared/reuse-first');

    await first.started;
    first.complete('ready-first');
    await expect(firstNavigation).resolves.toBe(true);

    const reusedElement = harness.routeNativeElement;
    expect(renderedText(harness)).toContain(
      'prepared reuse-first: ready-first',
    );
    expect(probe.activations).toEqual(['reuse-first']);

    const second = probe.plan('reuse-second');
    const secondNavigation = router.navigateByUrl('/prepared/reuse-second');
    await second.started;

    expect(router.url).toBe('/prepared/reuse-first');
    expect(location.path()).toBe('/prepared/reuse-first');
    expect(harness.routeNativeElement).toBe(reusedElement);
    expect(renderedText(harness)).toContain(
      'prepared reuse-first: ready-first',
    );

    second.complete('ready-second');
    await expect(secondNavigation).resolves.toBe(true);

    expect(router.url).toBe('/prepared/reuse-second');
    expect(location.path()).toBe('/prepared/reuse-second');
    expect(harness.routeNativeElement).toBe(reusedElement);
    expect(renderedText(harness)).toContain(
      'prepared reuse-second: ready-second',
    );
    expect(probe.activations).toEqual(['reuse-first']);
  });

  it('preserves committed state when destination preparation fails', async () => {
    const current = probe.plan('current');
    const currentNavigation = router.navigateByUrl('/prepared/current');

    await current.started;
    current.complete('ready-current');
    await expect(currentNavigation).resolves.toBe(true);

    const priorElement = harness.routeNativeElement;
    const priorText = renderedText(harness);

    await expect(router.navigateByUrl('/failed')).rejects.toThrow(
      'intentional router feasibility failure',
    );

    expect(router.url).toBe('/prepared/current');
    expect(location.path()).toBe('/prepared/current');
    expect(harness.routeNativeElement).toBe(priorElement);
    expect(renderedText(harness)).toBe(priorText);
    expect(probe.activations).toEqual(['current']);
  });
});
