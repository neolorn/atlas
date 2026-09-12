import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';

import { resolveConsumerProfile } from './package-consumer-profiles.mjs';
import { chromium, firefox, webkit } from 'playwright';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Which materialized consumer to drive, named by the caller so that every row can be driven. A row
// this stage cannot reach has no server-rendering, hydration, accessibility or browser evidence
// behind it, and "works on Angular 22.0.0" would then mean that its unit tests and a build passed
// rather than that it rendered and hydrated.
const consumerName = process.argv[2] ?? 'package-consumer';
const consumerProfile = resolveConsumerProfile(consumerName);
const consumerRoot = resolve(
  workspaceRoot,
  'tmp/package-consumer-verification',
  consumerName,
);
const serverEntry = resolve(
  consumerRoot,
  'dist/atlas-feature-lab/server/server.mjs',
);
const browserRoot = resolve(consumerRoot, 'dist/atlas-feature-lab/browser');
const prerenderManifestPath = resolve(
  consumerRoot,
  'dist/atlas-feature-lab/prerendered-routes.json',
);
// Every locale's copy of every prerendered route, and none that Atlas did not derive. The
// article's slug is spelled differently per locale, so its two addresses share no path segment
// after `/articles/`, which is exactly the expansion a hand-written table gets wrong silently.
const expectedPrerenderRoutes = Object.freeze([
  '/ar-eg/articles/دليل-أطلس',
  '/ar-eg/second',
  '/en-us/articles/atlas-handbook',
  '/en-us/second',
]);

function prerenderedRouteView(route) {
  return route.includes('/articles/') ? 'article' : 'second';
}
const { reqHandler } = await import(pathToFileURL(serverEntry).href);

// That import just took this process's failure reporting away, and this is where the harness takes
// it back.
//
// The consumer's server bundle calls Angular's `attachNodeGlobalErrorHandlers`, which registers
// `uncaughtException` and `unhandledRejection` listeners that write to `console.error` and return.
// Node suppresses its own default (print the error, exit non-zero) as soon as any listener is
// registered for those events. So from the line above onwards, every error that escaped was
// printed in full and the process exited 0: an assertion outside the `try` further down, a throw
// inside the static file server's request handler, a promise nobody awaited. This gate reported
// PASS for two complete pipelines over a consumer build it should have rejected, and the pass was
// indistinguishable from a real one.
//
// Note what the fix cannot be. Moving the assertions inside a `try` would cover the assertions and
// not the callbacks, and the next `createServer` handler or page listener would be outside it
// again. The property that has to hold is narrower and stronger than any block boundary: an error
// this file did not choose to handle ends the process non-zero. Listeners run in registration
// order and none can cancel another, so these run after Angular's: the message is printed twice,
// once by each, and then the process ends the way it always should have.
// `fetch` reports every network failure as a bare `TypeError: fetch failed` and puts the reason
// (a refused connection and the port it was refused on, a socket hang up, a DNS failure) in
// `cause`. Printing the top error alone turns a specific failure into a sentence that identifies
// nothing, which is the same shape of non-answer the bounds in this file exist to remove. One run
// reported exactly that and could not be diagnosed from its own log.
const describeError = (error) => {
  const parts = [];
  let current = error;
  for (
    let depth = 0;
    current !== undefined && current !== null && depth < 8;
  ) {
    parts.push(
      current instanceof Error
        ? (current.stack ?? current.message)
        : String(current),
    );
    current = current instanceof Error ? current.cause : undefined;
    depth += 1;
  }
  return parts.join('\ncaused by: ');
};

const failEscaped = (event) => (error) => {
  process.stderr.write(
    `Atlas browser assurance failed.\nEscaped as an ${event}, outside every handler in this file.\n${describeError(error)}\n`,
  );
  // `process.exit` rather than `process.exitCode`, because an escape can leave the static file
  // server or a browser holding the event loop open, and a gate that fails by hanging is no better
  // than one that fails by exiting 0.
  process.exit(1);
};
process.on('uncaughtException', failEscaped('uncaught exception'));
process.on('unhandledRejection', failEscaped('unhandled rejection'));

// And this is what proves the two listeners above still work, because nothing else can: a gate that
// has never been seen failing is indistinguishable from one that cannot fail, which is exactly the
// state this file was in. `verify:browser-assurance` does not run unless
// `verify:browser-assurance:self-test` has just watched this process exit non-zero for both classes
// of escape, against the same Angular bundle that installs the handlers being overridden, which
// is why the hook is here, after the import, and not in a unit test that never loads one.
const selfTest = process.env.ATLAS_ASSURANCE_SELF_TEST;
if (selfTest === 'assertion') {
  assert.fail(
    "Self-test escape: an assertion outside this file's own try block.",
  );
} else if (selfTest === 'rejection') {
  void Promise.reject(
    new Error('Self-test escape: a rejection nobody awaited.'),
  );
} else if (selfTest === 'diagnostics') {
  // Thrown inside the try below rather than here. The two above exercise the process-level
  // handlers and must escape everything; this one exercises the block that reports a failure the
  // run did catch, and that block only runs for a failure inside the try.
} else if (selfTest !== undefined) {
  assert.fail(`Unknown ATLAS_ASSURANCE_SELF_TEST value: ${selfTest}`);
}

// Where this run is, and a bound on how long it may stay there.
//
// The success line sits at the close of the `try` and the failure block after the `finally`, so
// without this a hung run and a working run are the same observation from outside. Telling them
// apart would need a reader who already knows how long the step takes, and a step that takes 29
// seconds can be watched for twenty minutes on the reading that it is merely slow.
//
// The budget is per stage rather than per run, because during a hang the useful question is never
// "how long has this taken" but "what is it waiting for", and a stage name answers it. Playwright
// hangs are awaits that never settle rather than busy loops, so a timer still fires; `unref` keeps
// a healthy run from being held open by one. The default is generous against a 29-second run (it
// is here to convert an unbounded wait into a report, not to police timing) and the environment
// variable is for a machine slow enough to need one.
const stageTimeoutMs = Number(
  process.env.ATLAS_ASSURANCE_STAGE_TIMEOUT_MS ?? 120_000,
);
assert.ok(
  Number.isSafeInteger(stageTimeoutMs) && stageTimeoutMs > 0,
  `ATLAS_ASSURANCE_STAGE_TIMEOUT_MS must be a positive whole number of milliseconds, not ${JSON.stringify(process.env.ATLAS_ASSURANCE_STAGE_TIMEOUT_MS)}`,
);
// What the row is doing right now, kept so the stage bound can report it.
//
// The `firefox-browser-row` bound has tripped three times and reported the stage name and nothing
// else: no console error, no page error, no request failure, because there were none. The stage
// simply did not finish. A bound that counts occurrences and cannot describe one is a tally rather
// than an instrument, and the passing durations (5258-5929ms against 120000ms) rule out its being
// the bound's own fault. So the row now carries a rolling account of what it last did and what it
// is still waiting for, and the watchdog prints it.
// Playwright bounds a call when its own signature carries a timeout: navigations, locator actions,
// the explicit waits. Everything else is unbounded by construction: `page.evaluate`,
// `elementHandle.evaluate`, `context.newPage`, and `page.close`, whose 1.61.1 signature takes
// `reason` and `runBeforeUnload` and nothing else, so `setDefaultTimeout` cannot reach it.
//
// A first version of this bounded `page.evaluate` and `page.evaluateHandle` on a hypothesis, and the
// next occurrence disproved it: the stage bound tripped at 120s on `verifyRenderingModes` while the
// evaluate bound stayed silent, which means the wait was in none of them. Enumerating the methods
// that lack a timeout is the same mistake one layer down: the list is wrong the first time anyone
// calls a method nobody thought of.
//
// So the rule is over the API rather than over the sites noticed so far: wrap every method, and race
// only what comes back as a thenable. A call that carries its own timeout reaches Playwright's bound
// first and reports Playwright's message; a call that carries none reaches this one, which names the
// method, its first argument, and what the row was doing. Handles that come back from a wrapped call
// are wrapped in turn, because `page.$()` returns the object whose `evaluate` is as unbounded as the
// page's own.
//
// The three bounds nest deliberately. Playwright's own is 15s for an action and 20s for a
// navigation; this one is 30s, above both so it never pre-empts a more specific message; the stage
// bound is 120s and stays as the outer guard for anything this file does not make a call for. What
// the tracker says about the recurring shape here: Firefox page.close hanging under parallel load
// (microsoft/playwright#22090, closed for 1.37), two Firefox contexts waiting endlessly (#34586, a
// 1.50.1 regression closed by PR #35116), and newPage timing out on Firefox (#36551, closed). All
// closed in releases older than the 1.61.1 pinned here, none of them naming a workaround to adopt.
const callTimeoutMs = Number(
  process.env.ATLAS_ASSURANCE_CALL_TIMEOUT_MS ?? 30_000,
);
assert.ok(
  Number.isSafeInteger(callTimeoutMs) && callTimeoutMs > 0,
  `ATLAS_ASSURANCE_CALL_TIMEOUT_MS must be a positive whole number of milliseconds, not ${JSON.stringify(process.env.ATLAS_ASSURANCE_CALL_TIMEOUT_MS)}`,
);

// The argument itself is the name. A line number would name this file, which is not where the wait
// is, and a label per call site is a list that goes stale the first time one is added.
const describeArgument = (target) =>
  target === undefined
    ? ''
    : `: ${String(typeof target === 'function' ? target.toString() : target)
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 160)}`;

// The walk has to actually reach the calls this exists for. Asserting it means a Playwright release
// that moves them fails loudly here, rather than going quiet in exactly the way the evaluate-only
// bound went quiet on the occurrence that disproved it.
const requireCoverage = (wrapped, kind) => {
  if (kind !== 'page') return;
  for (const required of ['close', 'evaluate']) {
    assert.ok(
      wrapped.has(required),
      `the call bound did not reach page.${required}, so nothing is bounding it`,
    );
  }
};

// What was wrapped, per object, rather than merely whether it was. A page usually arrives here
// already wrapped: it comes back from `context.newPage()`, which is itself a bounded call, so the
// resolve path below wraps it on the way out and the explicit call at the site is the second one.
// Recording the names means that second call can still check coverage rather than returning early,
// which would leave this guard unreachable.
const boundNames = new WeakMap();

const boundCalls = (target, kind) => {
  if (
    target === null ||
    (typeof target !== 'object' && typeof target !== 'function')
  ) {
    return target;
  }
  const already = boundNames.get(target);
  if (already !== undefined) {
    requireCoverage(already, kind);
    return target;
  }
  const wrapped = new Set();
  boundNames.set(target, wrapped);
  for (
    let level = Object.getPrototypeOf(target);
    level !== null && level !== Object.prototype;
    level = Object.getPrototypeOf(level)
  ) {
    for (const name of Object.getOwnPropertyNames(level)) {
      if (name === 'constructor' || name.startsWith('_') || wrapped.has(name)) {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(level, name);
      if (!descriptor || typeof descriptor.value !== 'function') continue;
      wrapped.add(name);
      const original = descriptor.value;
      Object.defineProperty(target, name, {
        configurable: true,
        enumerable: false,
        writable: true,
        value: function boundCall(...args) {
          const started = original.apply(this, args);
          // Synchronous returns (`page.locator(...)`, `page.url()`, `page.on(...)`) are not
          // waits and are handed back untouched.
          if (started === null || typeof started?.then !== 'function') {
            return started;
          }
          let timer;
          return Promise.race([
            started,
            new Promise((_resolve, reject) => {
              timer = setTimeout(() => {
                reject(
                  new Error(
                    `${kind}.${name} did not settle within ${callTimeoutMs}ms${describeArgument(args[0])}\n` +
                      `Playwright's own bound would have fired first had this call carried one, so this is a call it does not bound.\n` +
                      `What the row was doing: ${JSON.stringify(describeActivity(), null, 2)}`,
                  ),
                );
              }, callTimeoutMs);
            }),
          ]).then(
            (value) => {
              clearTimeout(timer);
              // A handle carries the same unbounded `evaluate` the page does.
              return typeof value?.evaluate === 'function'
                ? boundCalls(value, 'handle')
                : value;
            },
            (error) => {
              clearTimeout(timer);
              throw error;
            },
          );
        },
      });
    }
  }
  requireCoverage(wrapped, kind);
  return target;
};

// Heavy diagnostics, off unless asked for.
//
// The plainest form of the problem: page-side wrappers around every scroll-capable call, plus a
// Playwright subscription to every request the row makes, moved this row's failure rate from 6 in 40
// to 9 in 20. An instrument that changes what it measures is not one, and the honest response is a
// switch rather than an argument about which half did it. Declared here with the rest of the stage
// state, because the watchdog is armed by the first `enterStage` and reads all of it.
const traceCalls = process.env.ATLAS_ASSURANCE_TRACE_CALLS === '1';
const traceRequests = process.env.ATLAS_ASSURANCE_TRACE_REQUESTS === '1';

const rowActivity = {
  lastEvent: 'nothing yet',
  lastEventAt: Date.now(),
  awaiting: 'nothing yet',
  awaitingSince: Date.now(),
  inFlight: new Map(),
};

function noteActivity(what) {
  rowActivity.lastEvent = what;
  rowActivity.lastEventAt = Date.now();
}

// Which await the row is inside, kept apart from `lastEvent` on purpose. `lastEvent` is the most
// recent thing that happened and is overwritten by every navigation; this is the thing that has not
// happened yet, and it has to survive everything that happens while it waits. Recording the await
// through `noteActivity` was tried first and a deliberately shortened bound reported a URL, which is
// the reading this exists to replace.
function noteAwaiting(what) {
  rowActivity.awaiting = what;
  rowActivity.awaitingSince = Date.now();
}

function describeActivity() {
  const now = Date.now();
  const outstanding = [...rowActivity.inFlight.entries()]
    .map(([url, startedAt]) => `${url} (${now - startedAt}ms in flight)`)
    .slice(0, 10);
  return {
    awaiting: rowActivity.awaiting,
    awaitingForMs: now - rowActivity.awaitingSince,
    lastEvent: rowActivity.lastEvent,
    lastEventAgeMs: now - rowActivity.lastEventAt,
    requestsInFlight: traceRequests ? outstanding.length : 'not tracked',
    outstanding: traceRequests
      ? outstanding
      : 'set ATLAS_ASSURANCE_TRACE_REQUESTS=1',
  };
}

let verificationStage = 'startup';
let stageWatchdog;
let stageEnteredAt = Date.now();
// How long the stage that is ending took, on every run rather than only on the failing ones.
//
// The `firefox-browser-row` 120s bound has blown twice with nothing else reporting: no console
// error, no page error, no request failure. A bound sitting just above a row's typical duration
// produces exactly that: a rare, causeless timeout that is a defect in the bound rather than a hang.
// Deciding between the two needs the distribution of the passing runs, and `stageElapsedMs` was
// only ever written into the failure diagnostics, so a hundred green runs carried nothing to
// compare against. Now every stage prints what it cost as it ends.
const leaveStage = () => {
  process.stderr.write(
    `[assurance] ${verificationStage} finished in ${Date.now() - stageEnteredAt}ms\n`,
  );
};
const enterStage = (name) => {
  leaveStage();
  verificationStage = name;
  stageEnteredAt = Date.now();
  // stderr, because `verify.mjs` streams both but reprints stdout as a step's evidence.
  process.stderr.write(`[assurance] ${name}\n`);
  clearTimeout(stageWatchdog);
  stageWatchdog = setTimeout(() => {
    process.stderr.write(
      `Atlas browser assurance failed.\nStage ${JSON.stringify(name)} did not finish within ${stageTimeoutMs}ms. The bound is what separates a wait for something that is never coming from work in progress.\n` +
        `What the row was doing when the bound tripped: ${JSON.stringify(describeActivity(), null, 2)}\n` +
        `A last event that is seconds old with nothing in flight is a wait for something that is never coming, rather than work that is slow.\n`,
    );
    process.exit(1);
  }, stageTimeoutMs);
  stageWatchdog.unref();
};
enterStage('startup');

assert.equal(typeof reqHandler, 'function', 'SSR request handler is absent');

const prerenderManifest = JSON.parse(
  await readFile(prerenderManifestPath, 'utf8'),
);
assert.deepEqual(
  Object.keys(prerenderManifest.routes ?? {}).sort(),
  expectedPrerenderRoutes,
  'The built prerender manifest does not contain the exact Atlas prerender rows',
);
const prerenderArtifacts = new Map(
  await Promise.all(
    expectedPrerenderRoutes.map(async (route) => {
      const html = await readFile(
        resolve(browserRoot, route.slice(1), 'index.html'),
        'utf8',
      );
      assert.match(html, /<app-root\b/iu, `${route} prerender root is absent`);
      assert.match(
        html,
        new RegExp(`data-route-view="${prerenderedRouteView(route)}"`, 'u'),
        `${route} prerender route is absent`,
      );
      return [
        route,
        Object.freeze({
          digest: createHash('sha256').update(html, 'utf8').digest('hex'),
        }),
      ];
    }),
  ),
);

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

async function serveBrowserAsset(request, response) {
  let assetPath;

  try {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const relativePath = decodeURIComponent(pathname)
      .replace(/^\/+/, '')
      .replaceAll('/', sep);
    assetPath = resolve(browserRoot, relativePath);
  } catch {
    response.statusCode = 400;
    response.end('Invalid asset path');
    return;
  }

  if (
    assetPath === browserRoot ||
    !assetPath.startsWith(`${browserRoot}${sep}`)
  ) {
    response.statusCode = 404;
    response.end('Not found');
    return;
  }

  // A directory resolves to the `index.html` inside it, which is the deployment requirement Atlas
  // states in `specs/07-routing-rendering-and-seo.spec.md` section 9, met here rather than
  // assumed.
  //
  // **On 22.1.5 this line was what made a prerendered non-ASCII address reachable at all, and on
  // 22.1.7 it is not on that path any more.** That version looked its own prerendered assets up
  // without decoding the request path, so `/ar-eg/articles/%D8%AF...` missed the manifest entry the
  // same build wrote under the decoded name and fell through to here, and before this line it fell
  // through to `readFile` on a directory, which is `EISDIR` rather than `ENOENT` and answered 500,
  // so the address was unreachable through both paths at once. `baf1ca1` decodes before the lookup
  // (`buildServerAssetPathFromRequest`, `ssr.mjs:1379-1382` on 22.1.7), and re-measured on the bump
  // the engine now answers that address itself, `200` with `ng-server-context="ssg"`, without
  // reaching this function.
  //
  // The line stays, because what it meets is a requirement on the host and not a workaround for a
  // framework defect. A static file server or a CDN serving this build has no engine in front of it
  // and still has to map the directory itself; section 9.1 states that, and this fixture is where it
  // is measured. What the fix changes is which of the two paths answers first here, not whether the
  // requirement holds.
  if (extname(assetPath) === '') {
    assetPath = resolve(assetPath, 'index.html');
  }

  try {
    const content = await readFile(assetPath);
    response.statusCode = 200;
    response.setHeader(
      'Content-Type',
      contentTypes.get(extname(assetPath)) ?? 'application/octet-stream',
    );
    response.end(content);
  } catch (error) {
    response.statusCode =
      typeof error === 'object' && error !== null && error.code === 'ENOENT'
        ? 404
        : 500;
    response.end(response.statusCode === 404 ? 'Not found' : String(error));
  }
}

const server = createServer((request, response) => {
  const next = (error) => {
    if (response.writableEnded) {
      return;
    }

    if (error === undefined) {
      void serveBrowserAsset(request, response);
      return;
    }

    response.statusCode = 500;
    response.end(String(error));
  };

  try {
    const result = reqHandler(request, response, next);
    Promise.resolve(result).catch(next);
  } catch (error) {
    next(error);
  }
});

await new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(0, '127.0.0.1', resolveListen);
});

const address = server.address();
assert.notEqual(address, null, 'SSR server has no address');
assert.equal(typeof address, 'object', 'SSR server address is not TCP');
const origin = `http://127.0.0.1:${address.port}`;

async function closeServer() {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await Promise.race([
    new Promise((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error === undefined) {
          resolveClose();
        } else {
          rejectClose(error);
        }
      });
    }),
    new Promise((resolveClose) => setTimeout(resolveClose, 5_000)),
  ]);
}

async function render(label, locale = 'en-US', route = '') {
  const prefix = locale === 'ar-EG' ? 'ar-eg' : 'en-us';
  const response = await fetch(
    `${origin}/${prefix}${route}?label=${encodeURIComponent(label)}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  assert.equal(response.status, 200, `SSR failed for ${label}`);
  assert.equal(response.headers.get('content-language'), locale);
  return response.text();
}

function readSnapshot(html) {
  const document = new JSDOM(html).window.document;
  const probe = document.querySelector('[data-ssr-probe]');
  assert.notEqual(probe, null, 'SSR probe element is absent');
  const transferScript = document.querySelector('script#ng-state');
  assert.notEqual(transferScript, null, 'Angular TransferState is absent');
  const transferState = JSON.parse(transferScript.textContent ?? '{}');
  const atlasTransfer = transferState['@neolorn/atlas:localization-state/1'];
  assert.equal(
    atlasTransfer?.profile,
    'atlas-transfer-state/1',
    'Atlas TransferState is absent',
  );
  const dynamicTransfer = transferState['@atlas-feature-lab:dynamic-content/1'];
  assert.equal(
    dynamicTransfer?.profile,
    'atlas-feature-article-transfer/1',
    'Consumer-owned dynamic-content TransferState is absent',
  );

  const attribute = (name) => {
    const value = probe.getAttribute(name);
    assert.notEqual(value, null, `SSR probe attribute ${name} is absent`);
    return value;
  };

  return {
    document,
    requestId: attribute('data-request-id'),
    label: attribute('data-label'),
    source: attribute('data-source'),
    locale: attribute('data-snapshot-locale'),
    transfer: atlasTransfer,
    dynamicTransfer,
  };
}

const browserRows = Object.freeze([
  Object.freeze({ id: 'chromium', label: 'Chromium', browserType: chromium }),
  Object.freeze({ id: 'firefox', label: 'Firefox', browserType: firefox }),
  Object.freeze({ id: 'webkit', label: 'WebKit', browserType: webkit }),
]);
const assuranceStyle =
  'html,body{min-inline-size:200vw;min-block-size:200vh;margin:0}';
const assuranceNonce = 'atlas-browser-assurance';

function inlineHashSources(html, tagName) {
  const pattern =
    tagName === 'script'
      ? /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/giu
      : /<style\b[^>]*>([\s\S]*?)<\/style>/giu;
  return [
    ...new Set(
      [...html.matchAll(pattern)].map(
        (match) =>
          `'sha256-${createHash('sha256')
            .update(match[1] ?? '', 'utf8')
            .digest('base64')}'`,
      ),
    ),
  ];
}

function applyStrictBrowserPolicy(html, url) {
  const documentWithNonce = html.replace(
    /<app-root\b/iu,
    `<app-root ngCspNonce="${assuranceNonce}"`,
  );
  assert.notEqual(
    documentWithNonce,
    html,
    `Browser assurance could not attach the Angular CSP nonce to ${url}: ${html.slice(0, 200)}`,
  );
  const documentWithAssuranceStyle = documentWithNonce.replace(
    /<\/head>/iu,
    `<style data-atlas-browser-assurance>${assuranceStyle}</style></head>`,
  );
  assert.notEqual(
    documentWithAssuranceStyle,
    documentWithNonce,
    'Browser assurance could not inject its hashed layout style',
  );
  assert.equal(
    /<[^>]+\son[a-z]+\s*=/iu.test(documentWithAssuranceStyle),
    false,
    'The consumer HTML contains an inline event handler that strict CSP rejects',
  );

  // The policy the consumer is served under, and `specs/09-safe-content-and-ux.spec.md` section 6
  // is what serving it proves: nothing Atlas ships needs an inline script, an unsafe evaluation,
  // a sanitizer bypass, or a permissive Trusted Types policy. Script comes from the application's
  // own origin and the hashes of what this document actually contains, attribute-position script
  // and plugin content are denied outright, and Trusted Types are required for script, so a
  // consumer already running under a strict policy pays nothing to add Atlas to it.
  const scriptHashes = inlineHashSources(documentWithAssuranceStyle, 'script');
  const styleHashes = inlineHashSources(documentWithAssuranceStyle, 'style');
  const policy = [
    "default-src 'none'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    `script-src 'self' ${scriptHashes.join(' ')}`.trim(),
    "script-src-attr 'none'",
    `style-src 'self' 'nonce-${assuranceNonce}' ${styleHashes.join(' ')}`.trim(),
    "style-src-attr 'none'",
    "require-trusted-types-for 'script'",
    'trusted-types angular angular#bundler',
  ].join('; ');

  return { body: documentWithAssuranceStyle, policy };
}

async function installStrictBrowserPolicy(context) {
  await context.addInitScript(() => {
    globalThis.__atlasCspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      globalThis.__atlasCspViolations.push({
        blockedUri: event.blockedURI,
        columnNumber: event.columnNumber,
        directive: event.effectiveDirective,
        disposition: event.disposition,
        lineNumber: event.lineNumber,
        sourceFile: event.sourceFile,
      });
    });
  });
  await context.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') {
      await route.fallback();
      return;
    }

    // Fetched without following redirects, so the browser performs the navigation itself and the
    // page ends up reporting the address it actually landed on. A redirect is also not an
    // application document, it carries no root element to attach a nonce to, and locale entry
    // makes these ordinary rather than exceptional.
    const response = await route.fetch({ maxRedirects: 0 });
    if (response.status() >= 300 && response.status() < 400) {
      await route.fulfill({ response });
      return;
    }
    const contentType = response.headers()['content-type'] ?? '';
    if (!contentType.includes('text/html')) {
      await route.fulfill({ response });
      return;
    }

    const originalDocument = await response.text();
    const protectedDocument = applyStrictBrowserPolicy(
      originalDocument,
      route.request().url(),
    );
    const headers = {
      ...response.headers(),
      'content-security-policy': protectedDocument.policy,
      'x-atlas-original-document-sha256': createHash('sha256')
        .update(originalDocument, 'utf8')
        .digest('hex'),
    };
    delete headers['content-encoding'];
    delete headers['content-length'];
    await route.fulfill({
      body: protectedDocument.body,
      headers,
      status: response.status(),
    });
  });
}

function createBrowserDiagnostics(row) {
  return {
    cspViolations: [],
    consoleErrors: [],
    engine: row.id,
    pageErrors: [],
    requestFailures: [],
  };
}

const criticalBrowserResourceTypes = new Set([
  'document',
  'font',
  'image',
  'script',
  'stylesheet',
]);

function attachBrowserDiagnostics(page, diagnostics) {
  page.on('console', (message) => {
    noteActivity(`console ${message.type()}`);
    if (message.type() === 'error')
      diagnostics.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => {
    noteActivity('pageerror');
    diagnostics.pageErrors.push(error.message);
  });
  page.on('framenavigated', (frame) =>
    noteActivity(`navigated ${frame.url()}`),
  );
  page.on('load', () => noteActivity('load'));
  page.on('domcontentloaded', () => noteActivity('domcontentloaded'));
  if (traceRequests) {
    page.on('request', (request) => {
      rowActivity.inFlight.set(request.url(), Date.now());
      noteActivity(`request ${request.resourceType()}`);
    });
    page.on('requestfinished', (request) => {
      rowActivity.inFlight.delete(request.url());
      noteActivity('requestfinished');
    });
  }
  page.on('requestfailed', (request) => {
    rowActivity.inFlight.delete(request.url());
    noteActivity('requestfailed');
    if (
      request.url().startsWith(origin) &&
      criticalBrowserResourceTypes.has(request.resourceType())
    ) {
      diagnostics.requestFailures.push(
        `${request.url()}: ${request.failure()?.errorText ?? 'unknown failure'}`,
      );
    }
  });
}

async function collectPolicyDiagnostics(page, diagnostics) {
  if (page.isClosed()) return;
  const violations = await page.evaluate(
    () => globalThis.__atlasCspViolations ?? [],
  );
  diagnostics.cspViolations.push(...violations);
}

function assertBrowserDiagnostics(diagnostics, label) {
  assert.deepEqual(
    diagnostics.consoleErrors,
    [],
    `${label} console errors were reported`,
  );
  assert.deepEqual(
    diagnostics.pageErrors,
    [],
    `${label} page errors were reported`,
  );
  assert.deepEqual(
    diagnostics.requestFailures,
    [],
    `${label} document or script requests failed`,
  );
  assert.deepEqual(
    diagnostics.cspViolations,
    [],
    `${label} strict Content Security Policy was violated`,
  );
}

async function launchBrowserRow(row) {
  try {
    return boundCalls(
      await row.browserType.launch({ headless: true }),
      'browser',
    );
  } catch (error) {
    throw new Error(
      `${row.label} could not start for Atlas browser assurance. ` +
        `Install the pinned engines with "pnpm exec playwright install chromium firefox webkit" and retry. ` +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function assertTrustedTypesPolicy(page, response, row) {
  assert.notEqual(response, null, `${row.label} navigation has no response`);
  assert.match(
    response.headers()['content-security-policy'] ?? '',
    /require-trusted-types-for 'script'/u,
    `${row.label} did not receive Trusted Types enforcement`,
  );
  const supported = await page.evaluate(
    () => typeof globalThis.trustedTypes === 'object',
  );
  if (row.id === 'chromium') {
    assert.equal(supported, true, 'Chromium unexpectedly lacks Trusted Types');
  }
  return supported;
}

async function assertDirectAccessibility(page) {
  assert.equal(await page.getByRole('main').count(), 1);
  assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1);
  // Atlas builds this region itself. Nothing in the consumer's templates renders it, which is the
  // property under test: an application that forgets to place an announcer still has one.
  const announcer = page.locator(
    'body > div[data-atlas-announcer][role="status"]',
  );
  assert.equal(await announcer.count(), 1);
  assert.equal(await announcer.getAttribute('aria-live'), 'polite');
  assert.equal(await announcer.getAttribute('aria-atomic'), 'true');
  assert.equal(
    await announcer.evaluate((element) => getComputedStyle(element).position),
    'fixed',
    'The announcement region is not visually hidden, so a strict style policy suppressed it',
  );
  assert.equal(
    await page.locator('[data-percent-input]').evaluate((element) => {
      if (!(element instanceof HTMLInputElement)) return 0;
      return element.labels?.length ?? 0;
    }),
    1,
    'The localized input has no programmatic label',
  );
  assert.deepEqual(
    await page
      .locator('button:visible, a[href]:visible')
      .evaluateAll((elements) =>
        elements
          .filter(
            (element) =>
              (element.getAttribute('aria-label') ?? '').trim() === '' &&
              (element.textContent ?? '').trim() === '',
          )
          .map((element) => element.outerHTML),
      ),
    [],
    'Visible buttons and links must have accessible names',
  );
  assert.equal(
    await page
      .locator('[data-locale-choice="en-US"]')
      .getAttribute('aria-current'),
    'true',
  );
  assert.equal(
    await page
      .locator('[data-locale-choice="ar-EG"]')
      .getAttribute('aria-current'),
    null,
    'The option that is not current must carry no aria-current at all',
  );
  assert.equal(await page.locator('[data-rich-link] a').count(), 1);
  assert.equal(await page.locator('[data-rich-action] button').count(), 1);
  const actionCount = Number(
    (await page.locator('[data-action-count]').textContent())?.trim(),
  );
  await page.locator('[data-rich-action] button').focus();
  await page.locator('[data-rich-action] button').press('Enter');
  await page.waitForFunction(
    (expected) =>
      Number(
        document.querySelector('[data-action-count]')?.textContent?.trim(),
      ) === expected,
    actionCount + 1,
  );
  await assertKeyboardLocaleAccessibility(page);
}

async function assertKeyboardLocaleAccessibility(page) {
  const announcer = page.locator('div[data-atlas-announcer][role="status"]');
  // Two events, one ordered stream, both timed.
  //
  // The assertion below is about the order of two things: the document committing to a locale, and
  // the announcer publishing a sentence about it. It failed once in five runs on the Angular 22.0.4
  // row (4.15) and reported only the two values it compared, which says the order was wrong and
  // nothing about what the order was, how far apart they were, or whether the commit had happened
  // at all. Both events are observable from this page, so both are recorded here, with
  // `performance.now()` on each, and the failure prints the sequence.
  //
  // `lang` on the document element is watched rather than polled, so the record is of the mutation
  // itself rather than of a sample that happened to catch it.
  await page.evaluate(() => {
    globalThis.__atlasAnnouncementObserver?.disconnect();
    globalThis.__atlasDocumentLocaleObserver?.disconnect();
    globalThis.__atlasAnnouncementObservations = [];
    const target = document.querySelector('[data-atlas-announcer]');
    if (target === null) throw new Error('Locale announcer is absent');
    const record = (extra) => {
      globalThis.__atlasAnnouncementObservations.push({
        at: Math.round(performance.now() * 100) / 100,
        busyArabic: document
          .querySelector('[data-locale-choice="ar-EG"]')
          ?.getAttribute('aria-busy'),
        busyEnglish: document
          .querySelector('[data-locale-choice="en-US"]')
          ?.getAttribute('aria-busy'),
        locale: document.documentElement.lang,
        currentArabic: document
          .querySelector('[data-locale-choice="ar-EG"]')
          ?.getAttribute('aria-current'),
        currentEnglish: document
          .querySelector('[data-locale-choice="en-US"]')
          ?.getAttribute('aria-current'),
        text: target.textContent?.trim() ?? '',
        ...extra,
      });
    };
    const observer = new MutationObserver(() =>
      record({ kind: 'announcement' }),
    );
    observer.observe(target, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    globalThis.__atlasAnnouncementObserver = observer;
    const documentObserver = new MutationObserver(() =>
      record({ kind: 'document-locale' }),
    );
    documentObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['lang', 'dir'],
    });
    globalThis.__atlasDocumentLocaleObserver = documentObserver;
  });

  /**
   * Wait for an element to hold focus, and say what holds it instead when it never does.
   *
   * Deliberately unlike the selection assertions in this file, which read once and do not retry. A
   * selection restored to a specific wrong offset was computed wrongly, and waiting for a second
   * component to overwrite it would certify the disagreement.
   *
   * This one was introduced on the argument that focus is different: that nothing of Atlas's runs
   * between `.focus()` and the read, leaving only the browser's own scheduling. That was wrong.
   * Atlas's interaction restore runs in there, and it was taking focus back from the control the
   * visitor had just moved to. The wait is what found that: it failed, and it named
   * `[data-locale-choice="ar-EG"]` as the holder, which is the entire diagnosis. An immediate read would have
   * said `false`.
   *
   * So the reason to keep it is not that focus converges. It is that a failure here has to say what
   * holds focus instead, and a bounded wait is what makes room to ask. The bound is short because
   * nothing here is loading.
   */
  const waitForFocus = async (handle, description) => {
    try {
      await page.waitForFunction(
        (element) => document.activeElement === element,
        handle,
        { timeout: 5_000 },
      );
    } catch {
      const holder = await page.evaluate(() => {
        const element = document.activeElement;
        if (element === null) return null;
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id === '' ? undefined : element.id,
          attributes: Object.fromEntries(
            [...element.attributes]
              .filter((attribute) => attribute.name.startsWith('data-'))
              .map((attribute) => [attribute.name, attribute.value]),
          ),
          text: (element.textContent ?? '').trim().slice(0, 80),
          isBody: element === document.body,
        };
      });
      assert.fail(
        `${description}. After five seconds focus is held by ${JSON.stringify(
          holder,
        )}, and focus on the document body means the element never took it rather than that another element stole it.`,
      );
    }
  };

  const switchWithKeyboard = async ({
    expectedLocale,
    expectedPathPrefix,
    selector,
  }) => {
    const control = page.locator(selector);
    const controlHandle = await control.elementHandle();
    assert.notEqual(controlHandle, null, `${selector} control is absent`);
    const previousAnnouncement = (await announcer.textContent())?.trim() ?? '';
    await page.evaluate(() => {
      globalThis.__atlasAnnouncementObservations = [];
    });
    await control.focus();
    await waitForFocus(
      controlHandle,
      `${selector} could not receive keyboard focus`,
    );
    await control.press('Enter');
    await page.waitForFunction(
      (locale) => document.documentElement.lang === locale,
      expectedLocale,
    );
    await page.waitForURL((url) => url.pathname.startsWith(expectedPathPrefix));
    await page.waitForFunction((previous) => {
      const text =
        document.querySelector('[data-atlas-announcer]')?.textContent?.trim() ??
        '';
      return text.length > 0 && text !== previous;
    }, previousAnnouncement);
    // Read once, on purpose, and not through `waitForFocus`. By this line the commit is
    // observably finished: the document locale changed, the URL changed, and the announcer spoke.
    // Restoring focus across that commit is Atlas's own work, so if focus is not back by the time
    // the commit is visible, it is late, and a wait here would hide exactly the defect the
    // assertion exists to catch.
    assert.equal(
      await controlHandle.evaluate(
        (element) => document.activeElement === element,
      ),
      true,
      `${selector} lost focus during the locale commit`,
    );

    // The whole stream, kept for the failure message: the filtered announcements are what the
    // assertions are about, and the unfiltered sequence is what makes a failure readable.
    const observed = await page.evaluate(
      () => globalThis.__atlasAnnouncementObservations ?? [],
    );
    const sequence = JSON.stringify(observed, null, 2);
    const committedAnnouncements = observed.filter(
      (observation) =>
        observation.kind === 'announcement' && observation.text.length > 0,
    );
    assert.ok(
      committedAnnouncements.length > 0,
      `${selector} did not publish a locale announcement. Observed:\n${sequence}`,
    );
    for (const observation of committedAnnouncements) {
      assert.equal(
        observation.locale,
        expectedLocale,
        `${selector} announced before the document locale committed. The sequence below is ordered by \`at\`, and a \`document-locale\` entry after an \`announcement\` one is the defect this assertion is named for:\n${sequence}`,
      );
      const arabic = expectedLocale === 'ar-EG';
      // `null`, not `"false"`: the option that is not current carries no `aria-current`, and
      // `undefined` here would mean the control itself was missing, which this must not pass.
      assert.equal(
        observation.currentArabic,
        arabic ? 'true' : null,
        `${selector} published an announcement with the wrong current state on the Arabic control:\n${sequence}`,
      );
      assert.equal(
        observation.currentEnglish,
        arabic ? null : 'true',
        `${selector} published an announcement with the wrong current state on the English control:\n${sequence}`,
      );
      assert.equal(
        observation.busyArabic,
        null,
        `${selector} published an announcement while the Arabic control was still busy:\n${sequence}`,
      );
      assert.equal(
        observation.busyEnglish,
        null,
        `${selector} published an announcement while the English control was still busy:\n${sequence}`,
      );
    }
  };

  try {
    await switchWithKeyboard({
      expectedLocale: 'ar-EG',
      expectedPathPrefix: '/ar-eg',
      selector: '[data-locale-choice="ar-EG"]',
    });
    await switchWithKeyboard({
      expectedLocale: 'en-US',
      expectedPathPrefix: '/en-us',
      selector: '[data-locale-choice="en-US"]',
    });
  } finally {
    await page.evaluate(() => {
      globalThis.__atlasAnnouncementObserver?.disconnect();
      globalThis.__atlasDocumentLocaleObserver?.disconnect();
      delete globalThis.__atlasAnnouncementObserver;
      delete globalThis.__atlasDocumentLocaleObserver;
      delete globalThis.__atlasAnnouncementObservations;
    });
  }
}

/**
 * Where the visitor is on the page, plus everything the numbers came from.
 *
 * **Two horizontal offsets, both returned, because in RTL they are different numbers.** One is
 * `Math.abs(scrollX)`, the other `maximum - Math.abs(scrollX)`. They agree in LTR, where `before`
 * is read, and disagree in RTL, where `after` is read, so a check computing one and printing the
 * other decides on a scale its own failure message does not show. A WebKit failure printed `inline: 84` beside a
 * check comparing 353 against 240, and the three numbers could not be reconciled by anyone reading
 * them. One expression now produces both, and each is named for the edge it is measured from.
 *
 * In an RTL document `scrollX` is `0` at the inline-start and runs negative to `-maximum` at the
 * inline-end. Measured on a synthetic page with 1720px of real horizontal range, identically on
 * Chromium 149, Firefox 151 and WebKit: `scrollTo(0)` reads `0`, `scrollTo(-500)` reads `-500`,
 * `scrollTo(-99999)` clamps to `-1720`, `scrollTo(+500)` clamps to `0`. So `fromInlineStart` is
 * `Math.abs(scrollX)`, and `fromLeftEdge`, the document x of the viewport's left edge, is
 * `maximum - Math.abs(scrollX)`. In LTR both are `scrollX` and the distinction does not arise.
 *
 * **Which of the two Atlas ought to preserve across a direction change is an open product question
 * and this file does not settle it.** The assertion below reads `fromLeftEdge`, because that is the
 * quantity `LocalizationInteractionRestore` computes and restores (`angular.ts:974`), so the check
 * is falsifiable against a commit that lands anywhere else without asserting that the convention is
 * the right one. Both numbers are printed on every failure, which is what makes the question
 * visible instead of buried in a formula.
 *
 * The raw inputs are returned alongside because a failure reporting only the derived number sends
 * an investigator nowhere, which is how this stood red for a while with the cause unattributed.
 *
 * The source is a string so that the settle assertion, which runs as a page predicate and cannot
 * call into this module, evaluates the same expression rather than a second copy of it.
 */
const SCROLL_STATE_SOURCE = `() => {
  const maximum = Math.max(
    0,
    document.documentElement.scrollWidth - globalThis.innerWidth,
  );
  const rtl = document.documentElement.dir === 'rtl';
  return {
    block: globalThis.scrollY,
    fromInlineStart: rtl ? Math.abs(globalThis.scrollX) : globalThis.scrollX,
    fromLeftEdge: rtl
      ? maximum - Math.abs(globalThis.scrollX)
      : globalThis.scrollX,
    maximum,
    raw: {
      dir: document.documentElement.dir,
      scrollX: globalThis.scrollX,
      scrollY: globalThis.scrollY,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: globalThis.innerWidth,
    },
  };
}`;

// The element under the viewport's inline-start edge (the left edge in LTR, the right edge in
// RTL) marked on the way in and matched on the way out.
//
// Probed two pixels in rather than at the boundary, because `elementFromPoint` at exactly
// `innerWidth` is outside the viewport and answers `null`. The block coordinate is a third of the
// way down, far enough from a sticky header to be page content rather than chrome.
//
// `mark` refuses to report success on the document element or the body: those are under every point
// on every page, so a check that accepted them would pass whatever the restore did.
// **Installed into the page rather than passed as source, and this is not a matter of taste.** The
// consumer serves `script-src 'self'` with hashes and no `unsafe-eval`, deliberately, and Playwright
// polls a *string* predicate by calling `eval` inside the page. It evaluates the string once through
// the debugger protocol first, which no page CSP governs, so a string predicate succeeds whenever
// the page is already settled at the first look and rejects with `EvalError` about a hundred
// milliseconds in whenever it genuinely has to wait. A wait that only works when nothing needs
// waiting for. Probed on all three engines with a CSP-carrying fixture: string predicate resolves
// when already true, CSP-rejected when it must poll, on Chromium 149, Firefox 151 and WebKit 26.5
// alike; function predicate resolves in both cases on all three.
//
// `mode` is a runtime argument now rather than something interpolated into source, so there is one
// definition of this and the wait calls the same one the marks and reads call.
const INLINE_START_WITNESS_SOURCE = `globalThis.__atlasInlineStartWitness = (mode) => {
  const rtl = document.documentElement.dir === 'rtl';
  const x = rtl ? globalThis.innerWidth - 2 : 2;
  const y = Math.round(globalThis.innerHeight / 3);
  const held = document.elementFromPoint(x, y);
  const identifiable =
    held !== null &&
    held !== document.documentElement &&
    held !== document.body;
  const describe = (element) =>
    element === null
      ? null
      : element.tagName.toLowerCase() +
        (element.id === '' ? '' : '#' + element.id) +
        (element.classList.length === 0
          ? ''
          : '.' + Array.from(element.classList).join('.'));
  if (mode === 'mark' && identifiable) {
    document
      .querySelectorAll('[data-atlas-inline-start-witness]')
      .forEach((previous) =>
        previous.removeAttribute('data-atlas-inline-start-witness'),
      );
    held.setAttribute('data-atlas-inline-start-witness', '');
  }
  return {
    marked: identifiable,
    cell: held === null ? null : held.closest('[data-inline-cell]')?.dataset.inlineCell ?? null,
    holds:
      held !== null &&
      held.closest('[data-atlas-inline-start-witness]') !== null,
    at: { x, y },
    dir: document.documentElement.dir,
    found: describe(held),
    expected: describe(
      document.querySelector('[data-atlas-inline-start-witness]'),
    ),
  };
};`;

/**
 * Where an element sits against the viewport, in the one shape both readings print.
 *
 * The actor this is aimed at is the one nothing here has watched: an element scrolled into view
 * because it was not in view. Playwright performs that itself before an action, from outside the
 * page and with no call any wrapper can see, and the two rows below click through
 * `locator.evaluate`, which performs no such check, so for *these* clicks the candidate is the
 * engine rather than the driver. Either way the question is the same and neither instrument could
 * answer it: was the control on screen when the page was placed, and was it still on screen when it
 * was clicked. A rect recorded at both moments answers it, and an `inView` that goes false between
 * them names a scroll nobody had a record of.
 *
 * Rounded, and no layout forced beyond the one `getBoundingClientRect`, because an instrument
 * whose cost changes the outcome is not an instrument. It runs twice a row.
 */
const RECT_AGAINST_VIEWPORT_SOURCE = `globalThis.__atlasRectAgainstViewport = (element, selector) => {
  const rect = element.getBoundingClientRect();
  const width = globalThis.innerWidth;
  const height = globalThis.innerHeight;
  return {
    selector,
    top: Math.round(rect.top),
    left: Math.round(rect.left),
    bottom: Math.round(rect.bottom),
    right: Math.round(rect.right),
    viewport: { width, height },
    scroll: { x: Math.round(globalThis.scrollX), y: Math.round(globalThis.scrollY) },
    inView:
      rect.top >= 0 && rect.left >= 0 && rect.bottom <= height && rect.right <= width,
  };
};`;

/**
 * A locale control clicked from inside the page, with its position recorded if anything is
 * recording.
 *
 * The click is a script call rather than `locator.click()`, which is deliberate and predates this:
 * a driver click carries actionability checks that move the page, and this row is measuring the
 * page's position. The rect is written where the recorder's own readings are, on the recorder's
 * clock, so the click sits on the same timeline as every scroll, frame and mutation beside it. A
 * row with no recorder installed writes nothing and clicks the same way.
 */
async function clickLocaleChoice(page, locale) {
  const selector = '[data-locale-choice="' + locale + '"]';
  await page.locator(selector).evaluate((element, name) => {
    if (!(element instanceof HTMLElement))
      throw new Error('Locale control is invalid');
    const record = globalThis.__atlasScrollRecord;
    if (
      record !== undefined &&
      globalThis.__atlasRectAgainstViewport !== undefined
    ) {
      // An array rather than a field: this row clicks twice with one recorder installed, and a
      // field would quietly keep the second and describe it as the click the placement pairs with.
      record.clicks ??= [];
      record.clicks.push({
        ...globalThis.__atlasRectAgainstViewport(element, name),
        at: Math.round(performance.now() - record.start),
      });
    }
    element.click();
  }, selector);
}

// Both readings go through the installed function, so there is nothing to keep in step.
const inlineStartWitness = (page, mode) =>
  page.evaluate(
    (requested) => globalThis.__atlasInlineStartWitness(requested),
    mode,
  );

const RECORDER_SOURCE = `() => {
  const state = ${SCROLL_STATE_SOURCE};
  const start = performance.now();
  const record = { positions: [state()], frames: [], start };
  record.positions[0].at = 0;

  // Where the placement sits on this clock, which is a negative number: it happened before the
  // recorder was installed. Without it every reading below is measured from a zero whose relation
  // to the one deliberate scroll in this check is not stated anywhere.
  const placement = globalThis.__atlasScrollPlacement;
  record.placement =
    placement === undefined
      ? null
      : {
          at: Math.round(placement.pageClock - start),
          scrollRestoration: placement.scrollRestoration,
          readyState: placement.readyState,
          target: placement.target ?? null,
        };
  const onScroll = () => {
    record.reading = true;
    const now = state();
    record.reading = false;
    now.at = Math.round(performance.now() - start);
    record.positions.push(now);
  };
  globalThis.addEventListener('scroll', onScroll, { passive: true });

  // Who called, and from where. A scroll event says the page moved; it does not say what moved it,
  // and two hypotheses have now died for want of that. Recorded rather than argued.
  //
  // Empty and off are different readings, and this report has not distinguished them. The wrappers
  // are behind a switch because installing them changed the failure rate, so in every unattended run
  // this array is empty because nothing was watching, not because nothing called. Four occurrences
  // were read as "no call could have moved it" out of an array that could not have held one. It says
  // which it is now.
  record.calls = [];
  // Which functions are actually wrapped, rather than whether any are.
  //
  // The boolean this replaces had two states for three situations. The three window entry points
  // below are wrapped on every run and the five element-level ones are not, so "the calls array is
  // empty" now means something different depending on which call you were looking for, and a
  // reader who cannot see the difference will read a real absence as a switched-off instrument, or
  // worse, the reverse. The list says exactly what an empty array is evidence about.
  record.callsWatched = [];
  const note = (api, detail) => {
    record.calls.push({
      at: Math.round(performance.now() - start),
      api,
      detail,
      // The consumer bundle is minified, so this names functions rather than lines. That is enough
      // to separate Atlas from Angular from the engine, which is the question.
      // fromCharCode rather than an escape: this source is produced by a template literal, so a
      // backslash-n here becomes a real newline inside a string literal in the emitted page code,
      // and the page fails to parse. Cost fourteen runs of nothing before it was noticed.
      stack: (new Error().stack ?? '')
        .split(String.fromCharCode(10))
        .slice(2, 8)
        .join(' | '),
    });
  };
  // A label rather than the property name, because five of the eight share three names with the
  // other three. A bare "scrollTo" in the calls array does not say whether the window or an element
  // was asked, and those are different events.
  //
  // No backticks in this comment, or in any comment in this source: it is produced by a template
  // literal, so one closes the literal and the file stops parsing. Second instance of the rule the
  // fromCharCode note below records.
  const wrap = (owner, label, name, describe) => {
    const original = owner[name];
    if (typeof original !== 'function') return;
    owner[name] = function (...args) {
      note(label, describe(args, this));
      return original.apply(this, args);
    };
    record.callsWatched.push(label);
  };
  const where = (element) =>
    element instanceof Element
      ? element.tagName.toLowerCase() +
        (element.id === '' ? '' : '#' + element.id) +
        (element.getAttribute('data-percent-input') === null ? '' : '[data-percent-input]')
      : String(element);
  // The three that stay on, and why they are not the three that cost anything.
  //
  // The set is switched as a whole because the measurement behind it covers the whole set, and
  // nothing in it separates these three. They are the window's own scroll entry points, and the things that call
  // them in this row are countable: Atlas's
  // restore calls scrollTo once per commit, the hold re-applies it a handful of times inside a
  // 150ms window, Angular's scroll-position restoration calls it once per navigation, and this
  // file's own disturbance calls it once. A wrapper on a function called single-digit times per row
  // is not what moved a failure rate.
  //
  // The five behind the switch are the ones with a hot path. HTMLElement.prototype.focus is on
  // every focus a hydrating application performs, Element.prototype.scrollTo and scrollIntoView are
  // called from inside focus and from the router's scroller, and the two selection methods are on
  // the path of every input interaction. Whichever of the eight cost the row its runs, it is one of
  // those five, so they stay off, and the question the calls array exists to answer is answerable
  // on every unattended run instead of none.
  wrap(globalThis, 'window.scrollTo', 'scrollTo', (args) => args.map(String).join(','));
  wrap(globalThis, 'window.scrollBy', 'scrollBy', (args) => args.map(String).join(','));
  wrap(globalThis, 'window.scroll', 'scroll', (args) => args.map(String).join(','));
  if (${traceCalls}) {
    wrap(Element.prototype, 'Element.scrollIntoView', 'scrollIntoView', (args, self) => where(self));
    wrap(Element.prototype, 'Element.scrollTo', 'scrollTo', (args, self) => where(self) + ' ' + args.map(String).join(','));
    wrap(HTMLElement.prototype, 'HTMLElement.focus', 'focus', (args, self) => where(self) + ' ' + JSON.stringify(args[0] ?? null));
    wrap(HTMLInputElement.prototype, 'HTMLInputElement.setSelectionRange', 'setSelectionRange', (args, self) => where(self) + ' ' + args.map(String).join(','));
    wrap(HTMLInputElement.prototype, 'HTMLInputElement.select', 'select', (args, self) => where(self));
  }
  // What the engine did, which the wrappers above cannot see.
  //
  // Those wrappers are JavaScript call sites, and a Playwright click focuses natively: no call is
  // made, nothing fires, and the report says the calls that could have moved it were none. That is
  // true, and it was read four times as "nothing touched the page" when what it meant was "nothing
  // that this instrument can see touched the page".
  //
  // Kept deliberately cheap, because heaviness here has already changed the answer once: wrapping
  // every scroll-capable call and subscribing to every request moved this row from 6 in 40 to 9 in
  // 20, which is why those are behind a switch. This is four passive capture listeners on the
  // document that fire a handful of times a row, push one small object, prevent nothing and cancel
  // nothing.
  record.events = [];
  for (const type of ['focusin', 'focusout', 'pointerdown', 'pointerup']) {
    document.addEventListener(
      type,
      (event) => {
        if (record.stopped || record.events.length >= 200) return;
        record.events.push({
          at: Math.round(performance.now() - start),
          type,
          target: where(event.target),
        });
      },
      { capture: true, passive: true },
    );
  }
  // What left the document.
  //
  // Kept because it is what rules replacement out as the explanation. One account of a scroll
  // range collapsing with nothing scrolling it is that the content making the range left the
  // document, and childList over the whole tree is what shows that. It shows the range intact at
  // every sample and nothing leaving the document until eight milliseconds after the position was
  // already zero, so replacement is not the explanation and this observer is what says so.
  //
  // A MutationObserver delivers in a microtask and reads nothing out of layout, so it does not move
  // what it is watching.
  record.mutations = [];

  // And what changed about what stayed.
  //
  // The sixth occurrence closed the account the observer above was installed for. The range never
  // collapsed, maximum read 1980 at every sample, and nothing left or entered the document
  // until eight milliseconds *after* the position was already zero. So the scrolling content was
  // not replaced, and a reset that precedes every other record has two remaining candidates. This
  // is the first: a change to an element that stayed exactly where it was. A dir or lang write,
  // a stylesheet arriving, an overflow or display toggle, a class swap: none of them move a
  // node, none of them call anything, and all of them can zero a scroll position.
  //
  // The same observer sees them for one more option, which makes this the cheapest instrument still
  // available: no wrapping, no layout read, delivered in a microtask. Its own array and its own cap,
  // so a hydrating application's attribute churn cannot crowd out the childList records that
  // already report.
  record.attributes = [];
  const describeNode = (node) =>
    node instanceof Element
      ? where(node)
      : node.nodeName + '(' + String(node.textContent ?? '').slice(0, 24) + ')';
  const short = (value) =>
    value === null || value === undefined ? null : String(value).slice(0, 160);
  const observer = new MutationObserver((entries) => {
    if (record.stopped) return;
    for (const entry of entries) {
      if (entry.type === 'attributes') {
        if (record.attributes.length >= 200) continue;
        record.attributes.push({
          at: Math.round(performance.now() - start),
          target: where(entry.target),
          name: entry.attributeName,
          from: short(entry.oldValue),
          to: short(
            entry.target instanceof Element
              ? entry.target.getAttribute(entry.attributeName)
              : null,
          ),
        });
        continue;
      }
      if (record.mutations.length >= 200) continue;
      if (entry.removedNodes.length === 0 && entry.addedNodes.length === 0)
        continue;
      record.mutations.push({
        at: Math.round(performance.now() - start),
        target: where(entry.target),
        removed: [...entry.removedNodes].map(describeNode),
        added: [...entry.addedNodes].map(describeNode),
      });
    }
  });
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true,
  });

  // What Atlas captured, at the moment it captured it.
  //
  // Atlas takes the position by reading scrollX and scrollY off the view, so the read is the
  // capture: wrapping the getter records the value Atlas saw and when it saw it, with nothing added
  // to the runtime and nothing prevented. That is what separates the two accounts. A capture before
  // the reset means Atlas held a good position and something else lost it. A capture after means
  // Atlas restored a zero it had read faithfully, and the question becomes when in the transaction
  // the position is taken, which is what a switch moves.
  //
  // The recorder reads the same two properties on every scroll event, so it says so while it does,
  // and those reads are not recorded as somebody else's.
  record.reads = [];
  const carrier = (() => {
    for (
      let level = globalThis;
      level !== null;
      level = Object.getPrototypeOf(level)
    ) {
      if (Object.getOwnPropertyDescriptor(level, 'scrollX') !== undefined)
        return level;
    }
    return null;
  })();
  for (const axis of carrier === null ? [] : ['scrollX', 'scrollY']) {
    const original = Object.getOwnPropertyDescriptor(carrier, axis);
    if (original === undefined || original.get === undefined) continue;
    Object.defineProperty(globalThis, axis, {
      configurable: true,
      enumerable: original.enumerable,
      get() {
        const value = original.get.call(this);
        if (!record.stopped && !record.reading && record.reads.length < 200) {
          const frames = String(new Error().stack ?? '').split('\\n');
          record.reads.push({
            at: Math.round(performance.now() - start),
            axis,
            value,
            from: (frames[2] ?? frames[1] ?? '').trim().slice(0, 160),
          });
        }
        return value;
      },
    });
  }
  // And what the document did to itself, which is the other candidate.
  //
  // A document that is still loading, or one being restored from the back-forward cache, has its
  // scroll position set by the engine as part of the load. No script runs, no node moves, no
  // scroll-capable call is made, and nothing above would show it. The recorder goes in after
  // hydration has been waited for, so the expectation is that none of these fire, but that
  // expectation has never been read, and the reset it would explain precedes everything else.
  //
  // readyStateAtInstall is the half that makes an empty mean something. If the document was
  // already complete when the recorder went in, these events could not fire and their absence
  // says nothing; if it was not, the absence is a finding. Paid for in advance.
  record.lifecycle = { readyStateAtInstall: document.readyState, events: [] };
  for (const type of [
    'readystatechange',
    'DOMContentLoaded',
    'load',
    'pageshow',
  ]) {
    const target = type === 'load' || type === 'pageshow' ? globalThis : document;
    target.addEventListener(
      type,
      (event) => {
        if (record.stopped || record.lifecycle.events.length >= 50) return;
        record.lifecycle.events.push({
          at: Math.round(performance.now() - start),
          type,
          readyState: document.readyState,
          persisted: event.persisted ?? null,
        });
      },
      { capture: true, passive: true },
    );
  }

  const beat = () => {
    if (record.stopped) return;
    record.frames.push(Math.round(performance.now() - start));
    requestAnimationFrame(beat);
  };
  requestAnimationFrame(beat);
  record.stop = () => {
    record.stopped = true;
    observer.disconnect();
    globalThis.removeEventListener('scroll', onScroll);
  };
  globalThis.__atlasScrollRecord = record;
}`;

// Frame timestamps compress to the gaps between them, because a five-second run at 60fps is three
// hundred numbers that all say the same thing. What a reader needs is the longest interval in which
// no frame ran, and how many frames there were at all.
function frameGaps(frames) {
  if (frames.length === 0) return { frames: 0, longestGapMs: null };
  let longest = frames[0];
  for (let index = 1; index < frames.length; index += 1) {
    longest = Math.max(longest, frames[index] - frames[index - 1]);
  }
  return {
    frames: frames.length,
    firstAt: frames[0],
    lastAt: frames[frames.length - 1],
    longestGapMs: longest,
  };
}

// Everything the recorder holds, read once and stopped. Every failure in the continuity stage wants
// it, so it is not written into any single message.
async function describeRecord(page) {
  const record = await page.evaluate(
    `(() => {
      const held = globalThis.__atlasScrollRecord;
      if (held === undefined) return null;
      held.stop();
      return {
        positions: held.positions,
        frames: held.frames,
        calls: held.calls ?? [],
        callsWatched: held.callsWatched ?? [],
        events: held.events ?? [],
        mutations: held.mutations ?? [],
        reads: held.reads ?? [],
        attributes: held.attributes ?? [],
        lifecycle: held.lifecycle ?? null,
        placement: held.placement ?? null,
        clicks: held.clicks ?? [],
      };
    })()`,
  );
  return record === null
    ? 'no recorder was installed'
    : `${JSON.stringify(record.positions)}, over ${JSON.stringify(frameGaps(record.frames))}, ` +
        `and the calls that could have moved it: ${JSON.stringify(record.calls)}, ` +
        `out of ${JSON.stringify(record.callsWatched)}: an empty array is an absence for those and ` +
        `says nothing about the rest, which are behind ATLAS_ASSURANCE_TRACE_CALLS=1, ` +
        `nor about the engine, which moves the page without calling anything, ` +
        `with what the engine originated: ${JSON.stringify(record.events)}, ` +
        `what left or entered the document: ${JSON.stringify(record.mutations)}, ` +
        `what read the position: ${JSON.stringify(record.reads)}, ` +
        `what changed about what stayed: ${JSON.stringify(record.attributes)}, ` +
        `what the document did to itself: ${JSON.stringify(record.lifecycle)}, ` +
        `and the placement all of it is measured from: ${JSON.stringify(record.placement)}, ` +
        `and where each control sat when it was clicked: ${JSON.stringify(record.clicks)}. ` +
        `An inView that is true at the placement and false at the first of these is a scroll no wrapper sees`;
}

async function logicalScrollState(page) {
  // Called here rather than passed: a string that evaluates to a function is serialized back as
  // `undefined`, not invoked. Every reader of the source wraps it the same way.
  return page.evaluate(`(${SCROLL_STATE_SOURCE})()`);
}

/**
 * The placement, and the two facts recorded at it rather than argued about afterwards.
 *
 * The recorder installs *after* this call, so its clock starts here-plus-epsilon and every reading
 * it prints is relative to a zero the reader cannot place. Stashing the page clock here lets the
 * recorder state the placement as an offset on its own scale, which is what separates a reset that
 * happened before the watched interval from one that happened inside it.
 *
 * `history.scrollRestoration` is read because an engine restoring a position it remembers is one of
 * the classes of action nothing else here can see, and its value says whether that class is live at
 * all. Read and recorded, never written: setting it would change the thing being measured.
 */
async function placeVisitorMidPage(page, target = null) {
  await page.evaluate((selector) => {
    globalThis.scrollTo(240, 360);
    const element = selector === null ? null : document.querySelector(selector);
    globalThis.__atlasScrollPlacement = {
      pageClock: performance.now(),
      scrollRestoration: history.scrollRestoration,
      readyState: document.readyState,
      target:
        element === null
          ? null
          : globalThis.__atlasRectAgainstViewport(element, selector),
    };
  }, target);
}

async function exerciseLocaleContinuity(page) {
  const input = page.locator('[data-percent-input]');
  await input.fill('50%');
  await input.focus();
  await input.evaluate((element) => {
    if (!(element instanceof HTMLInputElement)) {
      throw new Error('Localized percent control is not an input');
    }
    element.setSelectionRange(1, 2, 'forward');
  });
  // A viewport narrow enough that the page genuinely overflows, restored before returning.
  //
  // Without it this check was decided by incidental layout width. At the default 1280 the fixture
  // has around 10px of horizontal range, so `scrollTo(240)` clamps to the maximum, and the old
  // inverted formula also answered the maximum at rest, so the two errors cancelled and the
  // assertion passed. When something made the page wider, 240 no longer clamped, the cancellation
  // stopped, and it failed. That is the whole of why this gate was green some runs and red others,
  // in whichever stage happened to reach it first.
  const priorViewport = page.viewportSize();
  await page.setViewportSize({ width: 420, height: 700 });
  await page.evaluate(RECT_AGAINST_VIEWPORT_SOURCE);
  await placeVisitorMidPage(page, '[data-locale-choice="ar-EG"]');
  const before = await logicalScrollState(page);
  // Strictly greater than the offset, so 240 is a position in the middle of the range rather than
  // its end. Equal would mean the scroll had clamped, and a clamped start is what made the old
  // check vacuous.
  assert.ok(
    before.maximum > 240,
    `The logical-scroll fixture has too little horizontal range to place a 240px offset mid-page: ${JSON.stringify(before)}`,
  );
  assert.equal(
    before.fromLeftEdge,
    240,
    `The logical-scroll fixture clamped the inline offset, so nothing below distinguishes a preserved position from a lost one: ${JSON.stringify(before)}`,
  );
  // The document is LTR here, where the two offsets are the same number. Asserted rather than
  // assumed, because everything below compares an LTR reading against an RTL one and that is only
  // meaningful while the starting point is unambiguous.
  assert.equal(
    before.fromInlineStart,
    before.fromLeftEdge,
    `The starting position was read in a document that is not LTR, so the two inline offsets already disagree and nothing below compares like with like: ${JSON.stringify(before)}`,
  );
  assert.ok(
    before.block > 0,
    'The logical-scroll fixture did not reach a nonzero block position',
  );

  // Installed before the commit, because the interval that decides this check is the one between
  // the commit and the settle, and nothing was watching it. Two independent records:
  //
  //   `positions`. One entry per `scroll` event, which is every position the page took. A scroll
  //   listener rather than a per-frame read: reading `scrollX` on every frame forces layout on every
  //   frame, and an instrument whose cost changes the outcome is not an instrument.
  //
  //   `frames`: a requestAnimationFrame heartbeat recording nothing but a timestamp. Playwright
  //   polls `waitForFunction` on rAF, so a gap here is a period in which the predicate could not
  //   have run whatever the page was doing. That is the difference between "it never got there" and
  //   "nobody was looking", and it is not answerable after the fact.
  await page.evaluate(`(${RECORDER_SOURCE})()`);

  // The expectation, written by hand: whatever element the visitor had at their inline-start edge
  // before the commit is the element there after it.
  //
  // **Not a number, and deliberately not one.** Every numeric form of this check recomputes an
  // expression Atlas also computes, so it agrees with the implementation by construction on what the
  // quantity *means* and can only ever check the arithmetic. A check drawn from the same source as
  // its subject is why a restore that returned the visitor to the wrong content passed this gate
  // on three engines: the assertion and the runtime shared a definition, and the definition was
  // the defect.
  //
  // An element cannot be shared with a formula. It is marked here, before anything moves, and read
  // back afterwards; if the commit replaced the node rather than moving it the mark is gone and this
  // fails, which is also a thing worth failing on.
  await page.evaluate(INLINE_START_WITNESS_SOURCE);
  const witness = await inlineStartWitness(page, 'mark');
  // A strip cell, specifically, and the check refuses to run on anything else.
  //
  // The rest of this page is one column, so every element under the inline-start edge spans the
  // whole width and is found there whichever position the restore lands on. Against that fixture
  // this check passed the design it was written to reject, which is what a fixture too small to
  // tell two designs apart does. The strip exists to make the
  // two answers different elements, and requiring a cell here is what stops the check quietly
  // reverting to vacuous if the strip is ever moved out from under the probe.
  assert.ok(
    witness.cell !== null,
    `The viewport's inline-start edge is not over a cell of the inline scroll strip before the commit, so this check cannot tell a correct restore from the mirror-image one. Observed ${JSON.stringify(witness)}`,
  );

  await clickLocaleChoice(page, 'ar-EG');
  await page.waitForFunction(
    () =>
      document.documentElement.lang === 'ar-EG' &&
      document.documentElement.dir === 'rtl',
  );
  await page.waitForURL((url) => url.pathname.startsWith('/ar-eg'));
  const after = await logicalScrollState(page);
  assert.ok(
    after.maximum > 0,
    'The RTL document lost its horizontal scroll range',
  );
  // One read, so the four facts describe the same moment, and one assertion, so a failure carries
  // all of them.
  //
  // These were four separate `assert.equal` calls with no messages. A WebKit 26.5 run failed
  // with `3 !== 1` and nothing else: not which field, not what the selection had become, not
  // whether the element still had focus, not what was in it. `3` is the end of `50%`, so the
  // selection had collapsed to the caret, but that had to be worked out from the fixture rather
  // than read from the failure, which is the difference between a measurement and a guess (4.15).
  const selection = await input.evaluate((element) => {
    if (!(element instanceof HTMLInputElement)) {
      throw new Error('Localized percent control is not an input');
    }
    return {
      active: document.activeElement === element,
      direction: element.selectionDirection,
      end: element.selectionEnd,
      start: element.selectionStart,
      value: element.value,
    };
  });
  assert.deepEqual(
    {
      active: selection.active,
      direction: selection.direction,
      end: selection.end,
      start: selection.start,
    },
    { active: true, direction: 'forward', end: 2, start: 1 },
    `The selection inside the localized percent control did not survive the RTL commit. Observed ${JSON.stringify(selection)}, and the value is ${JSON.stringify(selection.value)}, so a start equal to its length is a collapsed caret rather than a moved selection.`,
  );
  // The block axis is not asserted here, against `after`, and the reason is worth keeping: that
  // reading is taken the instant the direction flip lands, before the hold has done its work.
  //
  // **The block position is Atlas's to keep, and the movement it keeps it against is WebKit's.** On
  // a writing-direction change WebKit reveals an element that already has focus, moving both axes
  // some milliseconds after Atlas has written the position, with no scroll call from any script in
  // between. Reproduced with no Atlas and no framework in the page; `focus({ preventScroll: true })`
  // is honoured and is not what does it. `holdScroll` re-applies the position against exactly that,
  // so "Block scroll moved during the RTL commit" is a condition worth failing on, read at a
  // moment when the answer has settled. Read at the instant of the flip it fails about one run in
  // five on a page that is behaving correctly.
  //
  // Reported upstream and open: https://bugs.webkit.org/show_bug.cgi?id=323563,
  // WebKit / Scrolling, *"A focused element is revealed after a writing-direction change,
  // overriding the scroll position the page just set"*. The hold stays whatever happens to it:
  // it is what makes three engines agree, and a fix would arrive in one engine's future version
  // while Atlas keeps supporting the ones already out. What the bug number changes is that the
  // next person to read this can see whether the behaviour is still WebKit's position.
  //
  // Atlas holds the position against it for a bounded window, so the honest moment to read the
  // page is once it has settled, which is where the inline axis was already being read. Both axes
  // are asserted there, together, in one wait. `after` stays as evidence, because where the page
  // went in between is exactly what a failure needs to show.

  // One outcome, required of all three engines, rather than a disjunction that also accepts the
  // inline-start. The engines do not disagree here: they land where Atlas sends them, every time.
  // Accepting the inline-start as well admits a frame of a restore in progress as an outcome, and
  // the row then passes with the restore deleted outright, because a page that never restored and
  // a page mid-restore read identically.
  //
  // The wait is the honest instrument here for the same reason it is for focus: Atlas has scheduled
  // the scroll and the browser applies it over frames, with nothing of Atlas's running in between.
  // The failure prints where the page went and when, so a restore that lands somewhere else and a
  // restore that never happens are different reports rather than the same timeout.
  //
  // Polled on an interval rather than on animation frames. Playwright's default is `raf`, which
  // means the predicate is evaluated inside a `requestAnimationFrame` callback and therefore only
  // while the row is producing frames; the installed playwright-core documents the option as
  // "Defaults to raf". This wait expired twice with its own predicate true at the moment it
  // expired, which is a gate failing a page that had already done what was asked of it: the
  // predicate was never the problem, the opportunity to ask it was. An interval is also the cheaper
  // instrument here: `elementFromPoint` forces layout, and 100ms costs fifty layouts over the five
  // seconds where frames cost about three hundred. An instrument's own cost cuts both ways.
  const settleStartedAt = Date.now();
  // Why it did not succeed, not merely that it did not. A rejected `waitForFunction` and an expired
  // one are different events with different subjects (the first is about the wait, the second
  // about the page) and folding both into `false` made the failure message assert a timeout it had
  // not observed.
  let settleFailure = null;
  const settled = await page
    .waitForFunction(
      // Both axes, one moment. The inline axis is an element, whatever the visitor had at their
      // inline-start edge, because a number there would be a formula Atlas also computes. The
      // block axis has no such element to hand: the strip's cells are 900px tall, so a block move
      // of a few hundred pixels finds the same cell and an element check cannot see it.
      // What is asserted instead is the reading taken before the commit, carried in from outside
      // the page. That is a value the harness observed, not an expression it recomputed.
      (expectedBlock) =>
        globalThis.__atlasInlineStartWitness('read').holds &&
        Math.abs(globalThis.scrollY - expectedBlock) <= 2,
      before.block,
      {
        // An interval rather than animation frames. The reason first given for this was a
        // hypothesis, that a row whose frames stopped was a row whose predicate stopped being
        // asked, and that hypothesis is dead: the wait was never being asked at all. What is left
        // is cost. `elementFromPoint` forces layout, and 100ms spends fifty of those over the five
        // seconds where frames would spend about three hundred. A judgement, not a measurement, and
        // recorded as one.
        polling: 100,
        timeout: 5_000,
      },
    )
    .then(
      () => true,
      (error) => {
        settleFailure = error;
        return false;
      },
    );
  const settleElapsedMs = Date.now() - settleStartedAt;
  if (!settled) {
    const trajectory = await page.evaluate(
      `(async () => {
        const state = ${SCROLL_STATE_SOURCE};
        const samples = [];
        const start = performance.now();
        while (performance.now() - start < 300) {
          const now = state();
          samples.push({
            at: Math.round(performance.now() - start),
            dir: now.raw.dir,
            scrollX: now.raw.scrollX,
            fromInlineStart: now.fromInlineStart,
            fromLeftEdge: now.fromLeftEdge,
            maximum: now.maximum,
            width: now.raw.scrollWidth,
            inner: now.raw.innerWidth,
          });
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return samples.filter(
          (sample, index) =>
            index === 0 || sample.scrollX !== samples[index - 1].scrollX,
        );
      })()`,
    );
    const settledAt = await logicalScrollState(page);
    const during = await describeRecord(page);
    const held = await inlineStartWitness(page, 'read');

    const inlineHeld = held.holds;
    const blockHeld = Math.abs(settledAt.block - before.block) <= 2;
    assert.fail(
      `The RTL commit did not return the visitor to the position they left. ` +
        `Inline axis: ${inlineHeld ? 'held' : 'MOVED'}. The element at their inline-start edge. ` +
        `Block axis: ${blockHeld ? 'held' : 'MOVED'}. ${before.block} before, ${settledAt.block} once the wait ended. ` +
        (blockHeld || inlineHeld
          ? ''
          : `Both axes moving together is the signature of an engine revealing a focused element rather than of a restore landing wrongly. `) +
        `The wait ended after ${settleElapsedMs}ms of a 5000ms budget, ` +
        (settleElapsedMs < 4_500
          ? `which is not an expiry: it rejected. `
          : `which is an expiry. `) +
        `What ended it: ${settleFailure === null ? 'nothing: it resolved falsy, which should be impossible' : JSON.stringify(String(settleFailure.stack ?? settleFailure))}. ` +
        (held.holds
          ? `And the predicate was true when read immediately afterwards, so this is the wait failing rather than the page. `
          : '') +
        `Marked before the commit: ${JSON.stringify(witness.found)}. At the inline-start edge afterwards: ${JSON.stringify(held)}. ` +
        `A null "expected" there means the commit replaced the node rather than moving it, which is a different defect from a restore that landed wrongly. ` +
        `Everything below is evidence rather than the expectation. ` +
        `Before ${JSON.stringify(before)}, at the first read after the commit ${JSON.stringify(after)}, ` +
        `and once the five seconds had expired ${JSON.stringify(settledAt)}, in which \`fromInlineStart\` is the quantity Atlas holds. ` +
        `Sampled for a further 300ms from there, distinct positions only: ${JSON.stringify(trajectory)}. ` +
        `The sampling begins after the wait expires, so it describes where the page has come to rest and says nothing about what happened during the commit. ` +
        `Every position the page took between the commit and the expiry, and the animation frames that ran while it did: ${during}. ` +
        `A long gap in the frames is a period in which the predicate could not have been polled, whatever the page was doing.`,
    );
  }

  await page.evaluate(
    `(() => {
      globalThis.__atlasScrollRecord?.stop();
      delete globalThis.__atlasScrollRecord;
      delete globalThis.__atlasScrollPlacement;
    })()`,
  );

  if (priorViewport !== null) {
    await page.setViewportSize(priorViewport);
  }
  // Both halves end to end and in that order: the switch the visitor just made is written to a
  // cookie, and the cookie decides where a later locale-neutral request lands. Neither half
  // means anything alone: a cookie nobody reads, or a reader with nothing to read.
  const persistedCookies = await page.context().cookies();
  if (
    !persistedCookies.some(
      ({ name, value }) => name === 'atlas-locale' && value === 'ar-EG',
    )
  ) {
    // The first WebKit run on Linux failed here, and the message it failed with, five words,
    // could not tell an engine that declined to store the cookie from a harness reading the wrong
    // place for it. Both readings are taken now, because they are different findings and only one
    // of them is about Atlas.
    const documentCookie = await page
      .evaluate('document.cookie')
      .then((value) => JSON.stringify(value))
      .catch((error) => `unreadable: ${String(error)}`);
    assert.fail(
      `The locale switch was not remembered. ` +
        `The switch itself landed, everything asserted above this is about the page after it committed, so what is missing is the cookie meant to outlive it. ` +
        `The lab writes it from script, as \`atlas-locale=ar-EG; Path=/; Max-Age=31536000; SameSite=Lax\` with no \`Secure\`, over ${origin}. ` +
        `What the document reports: ${documentCookie}. ` +
        `Every cookie this context holds, for every origin: ${JSON.stringify(persistedCookies)}. ` +
        `In the document but not in the context is this harness reading the wrong place. ` +
        `In neither is the engine declining a first-party cookie over loopback, which is a finding about the engine. ` +
        `In both, under another name or value, is Atlas writing something other than what it documents.`,
    );
  }
  const rememberedEntry = await page.request.fetch(`${origin}/`, {
    maxRedirects: 0,
  });
  assert.equal(rememberedEntry.status(), 307);
  assert.equal(rememberedEntry.headers()['location'], '/ar-eg');
  assert.equal(rememberedEntry.headers()['cache-control'], 'private, no-store');
  assert.equal(
    (await page.locator('[data-percent-model]').textContent())?.trim(),
    '0.5',
  );
  assert.equal(
    await page.locator('[data-source-fallback]').getAttribute('lang'),
    'en',
  );
  assert.equal(
    await page.locator('[data-source-fallback]').getAttribute('dir'),
    'ltr',
  );
  assert.equal(
    await page
      .locator('[data-source-fallback]')
      .getAttribute('data-supplying-locale'),
    'en-US',
  );
  assert.equal(
    await page.locator('[data-person-name]').getAttribute('lang'),
    'ar',
  );
  assert.equal(
    await page.locator('[data-person-name]').getAttribute('dir'),
    'rtl',
  );
  assert.equal(
    await page.locator('[data-comment-id="community-ar"]').getAttribute('lang'),
    'ar',
  );
  assert.equal(
    await page.locator('[data-comment-id="community-ar"]').getAttribute('dir'),
    'rtl',
  );
  assert.equal(
    await page.locator('[data-comment-id="fixed-fr"]').getAttribute('lang'),
    'fr',
  );
  assert.equal(
    await page.locator('[data-comment-id="fixed-fr"]').getAttribute('dir'),
    'ltr',
  );

  await input.evaluate((element) => {
    if (!(element instanceof HTMLInputElement)) {
      throw new Error('Localized percent control is not an input');
    }
    element.value = 'composition in progress';
    element.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    );
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await clickLocaleChoice(page, 'en-US');
  await page.waitForFunction(
    () =>
      document.documentElement.lang === 'en-US' &&
      document.documentElement.dir === 'ltr',
  );
  await page.waitForURL((url) => url.pathname.startsWith('/en-us'));
  assert.equal(await input.inputValue(), 'composition in progress');
  assert.equal(
    await input.evaluate((element) => document.activeElement === element),
    true,
  );
  await input.evaluate((element) =>
    element.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true }),
    ),
  );
  assert.equal(
    (await page.locator('[data-percent-model]').textContent())?.trim(),
    '0.5',
  );

  await assertUnrequestedMovementIsUndone(page);
}

/**
 * A check whose success path and failure path run on different machinery has only ever been
 * tested on the path that succeeds.
 *
 * Everything above passes on Chromium and Firefox without the runtime's scroll hold ever performing
 * a single re-apply, because nothing on those engines moves the page after the restore. The hold is
 * the part of the restore this item exists for, and on two engines out of three no green run has
 * exercised it at all. On the third it fires about one run in five, which is not a test either:
 * it is a coincidence frequent enough to be mistaken for one.
 *
 * So the movement is supplied on purpose, on every engine, every run. A one-shot disturbance is
 * armed, the page is committed to Arabic, and the first scroll event arriving once the commit has
 * landed *and* the visitor is back at their element scrolls the page to the origin. That is a
 * movement Atlas did not request and no visitor made, delivered inside the hold's window by
 * construction rather than by timing: the trigger is Atlas's own restore landing, so it can arrive
 * neither early nor late.
 *
 * Two things are then required, and the second is what makes this a check rather than a hope: the
 * position comes back, **and the disturbance actually fired**.
 *
 * Runs last, and puts the page back the way it found it: English, and the caller's viewport.
 */
async function assertUnrequestedMovementIsUndone(page) {
  const priorViewport = page.viewportSize();
  await page.setViewportSize({ width: 420, height: 700 });
  await page.evaluate(RECT_AGAINST_VIEWPORT_SOURCE);
  await placeVisitorMidPage(page, '[data-locale-choice="ar-EG"]');
  const before = await logicalScrollState(page);
  assert.ok(
    before.maximum > 240,
    `The hold case has too little horizontal range to place a 240px offset mid-page: ${JSON.stringify(before)}`,
  );
  // The same three guards the commit check above carries, for the same reason: a starting point
  // that clamped, or that was read in a document already right-to-left, makes everything below
  // measure something other than what it says. Without them a bad placement here surfaces five
  // seconds later as a disturbance that never fired, which points at the wrong thing entirely.
  assert.equal(
    before.raw.dir,
    'ltr',
    `The hold case starts in a document that is not LTR, so the commit below is not a direction change and the movement it guards against does not arise: ${JSON.stringify(before)}`,
  );
  assert.equal(
    before.fromLeftEdge,
    240,
    `The hold case could not place the visitor mid-page; the inline offset clamped: ${JSON.stringify(before)}`,
  );
  assert.ok(
    before.block > 0,
    `The hold case did not reach a nonzero block position: ${JSON.stringify(before)}`,
  );
  await page.evaluate(INLINE_START_WITNESS_SOURCE);
  const witness = await inlineStartWitness(page, 'mark');
  assert.ok(
    witness.cell !== null,
    `The inline-start edge is not over a strip cell before the hold case, so it cannot tell a held position from a lost one. Observed ${JSON.stringify(witness)}`,
  );

  // The same recorder the commit check above installs, for the same reason, arrived here late.
  //
  // A Firefox run failed this with the disturbance never fired, the block axis held at
  // its pre-commit 360 and the inline axis resting at the origin, and the message could say only
  // where the page had come to rest, because nothing was watching the interval that decides this.
  // Whether the restore wrote the inline position at all, wrote it and had it clamped, or wrote it
  // and something moved it afterwards are three different defects that produce that one reading, and
  // no amount of re-reading the failure separates them. `positions` carries `dir` alongside every
  // scroll, so the next occurrence answers it rather than raising it again.
  await page.evaluate(`(${RECORDER_SOURCE})()`);

  await page.evaluate(() => {
    const disturbance = { firedAt: null, from: null, to: null, armed: true };
    globalThis.__atlasDisturbance = disturbance;
    globalThis.addEventListener(
      'scroll',
      () => {
        if (!disturbance.armed) return;
        // Not before the commit has landed (the document is left-to-right until it does, so this
        // cannot fire on the way in) and not before the restore has landed either, which is what
        // the witness says.
        if (document.documentElement.dir !== 'rtl') return;
        if (!globalThis.__atlasInlineStartWitness('read').holds) return;
        disturbance.armed = false;
        disturbance.from = { x: globalThis.scrollX, y: globalThis.scrollY };
        disturbance.firedAt = Math.round(performance.now());
        globalThis.scrollTo(0, 0);
        disturbance.to = { x: globalThis.scrollX, y: globalThis.scrollY };
      },
      { passive: true },
    );
  });

  await clickLocaleChoice(page, 'ar-EG');
  await page.waitForFunction(
    () =>
      document.documentElement.lang === 'ar-EG' &&
      document.documentElement.dir === 'rtl',
  );

  const undone = await page
    .waitForFunction(
      (expectedBlock) =>
        globalThis.__atlasDisturbance.firedAt !== null &&
        globalThis.__atlasInlineStartWitness('read').holds &&
        Math.abs(globalThis.scrollY - expectedBlock) <= 2,
      before.block,
      { polling: 100, timeout: 5_000 },
    )
    .then(
      () => true,
      () => false,
    );
  const record = await page.evaluate(() => globalThis.__atlasDisturbance);
  if (!undone) {
    const restingAt = await logicalScrollState(page);
    const stillThere = await inlineStartWitness(page, 'read');
    const during = await describeRecord(page);
    // Which axis, said out loud. Both moving together is an engine revealing a focused element;
    // one moving alone is not, and the two failures have nothing to do with each other.
    const axes =
      `The block axis ${Math.abs(restingAt.block - before.block) <= 2 ? 'held' : 'MOVED'} ` +
      `(${before.block} before, ${restingAt.block} now) and the inline axis ` +
      `${stillThere.holds ? 'held' : 'MOVED'} (${before.fromInlineStart} from the inline-start ` +
      `edge before, ${restingAt.fromInlineStart} now). `;
    assert.fail(
      record.firedAt === null
        ? `The deliberate disturbance never fired, so this run proved nothing about the hold. Its two arming conditions are that the Arabic commit has landed and that the visitor is back at their element; one of them was never met. Observed ${JSON.stringify(record)}, from ${JSON.stringify(before)}, resting at ${JSON.stringify(restingAt)}, with ${JSON.stringify(stillThere)} at the inline-start edge. ${axes}Every position the page took, with the direction it was in at each: ${during}.`
        : `A movement Atlas did not request and no visitor made was not undone. The page was scrolled from ${JSON.stringify(record.from)} to ${JSON.stringify(record.to)}, and five seconds later it is at ${JSON.stringify(restingAt)} with ${JSON.stringify(stillThere)} at the inline-start edge, against a block offset of ${before.block} before the commit. The hold either did not run, closed too early, or was closed by something on this page that reads as visitor input. ${axes}Every position the page took, with the direction it was in at each: ${during}.`,
    );
  }
  assert.notEqual(
    record.firedAt,
    null,
    'The hold case passed without its disturbance firing, which the wait is written to make impossible, if this ever fires, the wait has been weakened.',
  );

  // The instrument's own positive control, and this is the one stage that can carry it.
  //
  // An empty calls array is only evidence of absence once the array is known to be able to
  // hold something. Every other reader of this record is a failure message, so the wrappers were
  // last proven to work on a run that was already red, which is the wrong way round. Here the
  // stage has just asserted that its deliberate disturbance fired, and that disturbance calls
  // `globalThis.scrollTo(0, 0)`: a call this file made, at a moment the assertion above proves
  // happened. If the wrapper is uninstalled, misnamed, or shadowed by something the page does, this
  // is empty and says so on a green run rather than on the next red one.
  //
  // Atlas's own restore also calls it, and this deliberately does not assert that: what is being
  // proven is that the instrument records a call, not what the runtime called.
  const watched = await page.evaluate(
    `(() => {
      const held = globalThis.__atlasScrollRecord;
      return held === undefined
        ? null
        : { watched: held.callsWatched ?? [], calls: held.calls ?? [] };
    })()`,
  );
  assert.ok(
    watched !== null &&
      watched.watched.includes('window.scrollTo') &&
      watched.calls.some(
        (call) => call.api === 'window.scrollTo' && call.detail === '0,0',
      ),
    `The unconditional call wrappers did not record this file's own scroll to the origin, so an empty calls array in any failure message on this row is not evidence that nothing called. Observed ${JSON.stringify(watched)}.`,
  );

  await page.evaluate(() => {
    globalThis.__atlasScrollRecord?.stop();
    delete globalThis.__atlasScrollRecord;
    delete globalThis.__atlasScrollPlacement;
    delete globalThis.__atlasDisturbance;
  });
  await clickLocaleChoice(page, 'en-US');
  await page.waitForFunction(
    () =>
      document.documentElement.lang === 'en-US' &&
      document.documentElement.dir === 'ltr',
  );
  if (priorViewport !== null) {
    await page.setViewportSize(priorViewport);
  }
}

async function navigateWithScriptGate(page, url, beforeScripts) {
  let releaseScripts;
  const gate = new Promise((resolveGate) => {
    releaseScripts = resolveGate;
  });
  const routeHandler = async (route) => {
    await gate;
    await route.continue();
  };
  await page.route('**/*.js', routeHandler);
  const navigation = page.goto(url, { waitUntil: 'load' });

  try {
    await beforeScripts();
    releaseScripts();
    return await navigation;
  } finally {
    releaseScripts();
    await page.unroute('**/*.js', routeHandler);
  }
}

async function verifyRenderingModes(row, context, diagnostics) {
  const prerenderPath = '/en-us/second';
  const prerenderArtifact = prerenderArtifacts.get(prerenderPath);
  assert.notEqual(
    prerenderArtifact,
    undefined,
    `${prerenderPath} built prerender artifact is absent`,
  );
  const prerenderPage = boundCalls(await context.newPage(), 'page');
  attachBrowserDiagnostics(prerenderPage, diagnostics);
  prerenderPage.setDefaultTimeout(15_000);
  prerenderPage.setDefaultNavigationTimeout(20_000);
  let prerenderRoot;
  let prerenderRoute;
  const prerenderResponse = await navigateWithScriptGate(
    prerenderPage,
    `${origin}${prerenderPath}`,
    async () => {
      await prerenderPage.waitForSelector('[data-route-view="second"]');
      prerenderRoot = await prerenderPage.$('app-root');
      prerenderRoute = await prerenderPage.$('[data-route-view="second"]');
      assert.notEqual(
        prerenderRoot,
        null,
        `${row.label} prerender root is absent`,
      );
      assert.notEqual(
        prerenderRoute,
        null,
        `${row.label} prerender route is absent`,
      );
      assert.equal(
        await prerenderPage.locator('html').getAttribute('data-client-ready'),
        null,
      );
    },
  );
  await assertTrustedTypesPolicy(prerenderPage, prerenderResponse, row);
  assert.equal(
    prerenderResponse.headers()['x-atlas-original-document-sha256'],
    prerenderArtifact.digest,
    `${row.label} prerender response did not originate from the built static artifact`,
  );
  await prerenderPage.waitForFunction(
    () => document.documentElement.dataset['clientReady'] === 'true',
  );
  assert.equal(
    await prerenderRoot.evaluate(
      (element) => element === document.querySelector('app-root'),
    ),
    true,
    `${row.label} replaced the prerender root`,
  );
  assert.equal(
    await prerenderRoute.evaluate(
      (element) =>
        element === document.querySelector('[data-route-view="second"]'),
    ),
    true,
    `${row.label} replaced the prerender route`,
  );
  assert.equal(
    await prerenderPage.locator('link[rel="canonical"]').getAttribute('href'),
    'https://atlas.example/en-us/second',
  );
  await prerenderPage.locator('[data-locale-choice="ar-EG"]').click();
  await prerenderPage.waitForURL((url) => url.pathname === '/ar-eg/second');
  await prerenderPage.waitForFunction(
    () =>
      document.documentElement.lang === 'ar-EG' &&
      document.documentElement.dir === 'rtl',
  );
  if (row.id === 'chromium') {
    await collectPolicyDiagnostics(prerenderPage, diagnostics);
    await prerenderPage.goto(`${origin}/ar-eg/second`);
    await prerenderPage.waitForFunction(
      () => document.documentElement.dataset['clientReady'] === 'true',
    );
    assert.equal(
      await prerenderPage.locator('[data-route-view="second"]').textContent(),
      'الصفحة الثانية',
    );
  }

  const csrPage = boundCalls(await context.newPage(), 'page');
  attachBrowserDiagnostics(csrPage, diagnostics);
  csrPage.setDefaultTimeout(15_000);
  csrPage.setDefaultNavigationTimeout(20_000);
  const csrResponse = await navigateWithScriptGate(
    csrPage,
    `${origin}/en-us/items/42`,
    async () => {
      await csrPage.waitForSelector('app-root', { state: 'attached' });
      assert.equal(await csrPage.locator('[data-route-view]').count(), 0);
      assert.equal(
        await csrPage.locator('html').getAttribute('data-client-ready'),
        null,
      );
    },
  );
  await assertTrustedTypesPolicy(csrPage, csrResponse, row);
  await csrPage.waitForFunction(
    () => document.documentElement.dataset['clientReady'] === 'true',
  );
  await csrPage.waitForSelector('[data-route-view="item"]');
  assert.equal(await csrPage.locator('html').getAttribute('lang'), 'en-US');
  assert.equal(await csrPage.locator('html').getAttribute('dir'), 'ltr');

  const beforeSwitch = await inlineSourceCensus(csrPage);

  await csrPage.locator('[data-locale-choice="ar-EG"]').click();
  await csrPage.waitForURL((url) => url.pathname === '/ar-eg/items/42');
  await csrPage.waitForFunction(
    () =>
      document.documentElement.lang === 'ar-EG' &&
      document.documentElement.dir === 'rtl',
  );

  // A locale switch re-renders every localized surface on the page. If Atlas emitted inline
  // script or style anywhere in that path, it would appear here, and it would be
  // invisible to the violation count, because this harness's policy carries hashes and a nonce
  // that a strict deployed policy does not.
  assertNoInlineSourceAdded(
    beforeSwitch,
    await inlineSourceCensus(csrPage),
    'A locale switch',
  );

  await collectPolicyDiagnostics(prerenderPage, diagnostics);
  await collectPolicyDiagnostics(csrPage, diagnostics);
  await prerenderPage.close();
  await csrPage.close();
}

/**
 * Inline `<script>` and `<style>` elements currently in the document.
 *
 * The strict policy this harness serves allows the inline content Angular and the harness itself
 * need, through a nonce on `<app-root>` and sha256 hashes computed from the served HTML. The
 * strictest policy a consumer realistically deploys carries neither: plain `script-src 'self'`
 * and `style-src 'self'`, with no hashes and no nonce.
 *
 * So "zero CSP violations" alone does not establish that Atlas is safe under such a policy: the
 * allowances could be covering Atlas's own output. What settles it is that Atlas's runtime work
 * adds none: whatever inline content exists is present at load, and boot, hydration and a locale
 * switch introduce nothing further.
 */
async function inlineSourceCensus(page) {
  return await page.evaluate(() => ({
    scripts: document.querySelectorAll('script:not([src])').length,
    styles: document.querySelectorAll('style').length,
    styleAttributes: document.querySelectorAll('[style]').length,
  }));
}

function assertNoInlineSourceAdded(before, after, label) {
  assert.equal(
    after.scripts,
    before.scripts,
    `${label} added an inline <script> at runtime, which a bare script-src 'self' rejects`,
  );
  assert.equal(
    after.styles,
    before.styles,
    `${label} added an inline <style> at runtime, which a bare style-src 'self' rejects`,
  );
  assert.equal(
    after.styleAttributes,
    before.styleAttributes,
    `${label} added an inline style attribute at runtime, which style-src-attr 'none' rejects`,
  );
}

async function settleBrowserLifecycle(page) {
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[aria-busy="true"]').length === 0 &&
      document
        .querySelector('[data-dynamic-content]')
        ?.getAttribute('data-participant-status') === 'ready',
  );
  await page.evaluate(
    () =>
      new Promise((resolveSettle) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => setTimeout(resolveSettle, 0));
        });
      }),
  );
}

async function readLifecycleResourceSnapshot(page) {
  return page.evaluate(() => ({
    activeAnimations: document
      .getAnimations()
      .filter((animation) => animation.playState !== 'finished').length,
    announcer: document.querySelectorAll('[data-atlas-announcer]').length,
    busy: document.querySelectorAll('[aria-busy="true"]').length,
    canonical: document.querySelectorAll('link[rel="canonical"]').length,
    domElements: document.querySelectorAll('*').length,
    form: document.querySelectorAll('[data-localized-form]').length,
    main: document.querySelectorAll('main').length,
    participantReady: document.querySelectorAll(
      '[data-dynamic-content][data-participant-status="ready"]',
    ).length,
    resources: performance
      .getEntriesByType('resource')
      .map((entry) => {
        const url = new URL(entry.name);
        return `${entry.initiatorType}:${url.pathname}`;
      })
      .sort(),
    root: document.querySelectorAll('app-root').length,
    stylesheets: document.styleSheets.length,
  }));
}

async function commitEnduranceLocale(page, arabic, expectedSourceRequests) {
  const selector = arabic
    ? '[data-locale-choice="ar-EG"]'
    : '[data-locale-choice="en-US"]';
  const locale = arabic ? 'ar-EG' : 'en-US';
  const direction = arabic ? 'rtl' : 'ltr';
  const pathname = arabic ? '/ar-eg' : '/en-us';
  await page.locator(selector).click();
  await page.waitForURL((url) => url.pathname === pathname);
  await page.waitForFunction(
    ({ direction: expectedDirection, locale: expectedLocale }) =>
      document.documentElement.lang === expectedLocale &&
      document.documentElement.dir === expectedDirection,
    { direction, locale },
  );
  await page.waitForFunction(
    (expectedLocale) =>
      document.querySelector('[data-dynamic-article]')?.getAttribute('lang') ===
      expectedLocale,
    locale,
  );
  await page.waitForFunction(
    (expected) =>
      Number(
        document
          .querySelector('[data-dynamic-content]')
          ?.getAttribute('data-source-requests'),
      ) === expected,
    expectedSourceRequests,
  );
  await settleBrowserLifecycle(page);
  assert.equal(
    await page.locator(selector).getAttribute('aria-current'),
    'true',
  );
  assert.equal(await page.locator(selector).getAttribute('aria-busy'), null);
}

async function verifySwitchEndurance(page, row) {
  const requestIds = new Set();
  await page.emulateMedia({ reducedMotion: 'reduce' });

  for (let batch = 0; batch < 3; batch += 1) {
    await page.goto(
      `${origin}/en-us?label=${encodeURIComponent(`${row.id}-endurance-${batch}`)}`,
    );
    await page.waitForFunction(
      () => document.documentElement.dataset['clientReady'] === 'true',
    );
    assert.equal(
      await page.evaluate(
        () => globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches,
      ),
      true,
    );
    assert.equal(
      page.context().pages().length,
      1,
      `${row.label} retained a page from an earlier lifecycle batch`,
    );
    const requestId = await page
      .locator('[data-ssr-probe]')
      .getAttribute('data-request-id');
    assert.notEqual(requestId, null, `${row.label} request identity is absent`);
    assert.equal(
      requestIds.has(requestId),
      false,
      `${row.label} reused an SSR request identity across lifecycle batches`,
    );
    requestIds.add(requestId);

    let sourceRequests = Number(
      await page
        .locator('[data-dynamic-content]')
        .getAttribute('data-source-requests'),
    );
    sourceRequests += 1;
    await commitEnduranceLocale(page, true, sourceRequests);
    sourceRequests += 1;
    await commitEnduranceLocale(page, false, sourceRequests);
    const settledBaseline = await readLifecycleResourceSnapshot(page);
    assert.equal(settledBaseline.activeAnimations, 0);
    assert.equal(settledBaseline.busy, 0);
    assert.equal(settledBaseline.participantReady, 1);

    for (let index = 0; index < 8; index += 1) {
      sourceRequests += 1;
      await commitEnduranceLocale(page, index % 2 === 0, sourceRequests);
      assert.deepEqual(
        await readLifecycleResourceSnapshot(page),
        settledBaseline,
        `${row.label} lifecycle/resources did not settle in batch ${batch}, switch ${index}`,
      );
    }
  }
  assert.equal(requestIds.size, 3);
}

async function verifySecondaryBrowserRow(row) {
  const rowBrowser = await launchBrowserRow(row);
  const version = rowBrowser.version();
  const diagnostics = createBrowserDiagnostics(row);
  let rowContext;
  let rowPage;

  try {
    rowContext = boundCalls(await rowBrowser.newContext(), 'context');
    await installStrictBrowserPolicy(rowContext);
    rowPage = boundCalls(await rowContext.newPage(), 'page');
    attachBrowserDiagnostics(rowPage, diagnostics);
    rowPage.setDefaultTimeout(15_000);
    rowPage.setDefaultNavigationTimeout(20_000);
    const label = `${row.id}-hydration-request`;
    let rootBefore;
    let headingBefore;
    let probeBefore;
    noteAwaiting(`${row.id} the hydration navigation`);
    const response = await navigateWithScriptGate(
      rowPage,
      `${origin}/en-us?label=${encodeURIComponent(label)}`,
      async () => {
        await rowPage.waitForSelector(
          `[data-ssr-probe][data-label="${label}"]`,
        );
        rootBefore = await rowPage.$('app-root');
        headingBefore = await rowPage.$('h1');
        probeBefore = await rowPage.$('[data-ssr-probe]');
        assert.notEqual(rootBefore, null, `${row.label} SSR root is absent`);
        assert.notEqual(
          headingBefore,
          null,
          `${row.label} SSR heading is absent`,
        );
        assert.notEqual(probeBefore, null, `${row.label} SSR probe is absent`);
        assert.equal(
          await rowPage.locator('html').getAttribute('data-client-ready'),
          null,
        );
      },
    );
    await assertTrustedTypesPolicy(rowPage, response, row);
    await rowPage.waitForFunction(
      () => document.documentElement.dataset['clientReady'] === 'true',
    );
    assert.equal(
      await rootBefore.evaluate(
        (element) => element === document.querySelector('app-root'),
      ),
      true,
    );
    assert.equal(
      await headingBefore.evaluate(
        (element) => element === document.querySelector('h1'),
      ),
      true,
    );
    assert.equal(
      await probeBefore.evaluate(
        (element) => element === document.querySelector('[data-ssr-probe]'),
      ),
      true,
    );
    assert.equal(
      await rowPage
        .locator('[data-dynamic-content]')
        .getAttribute('data-source-requests'),
      '0',
    );
    await rowPage.locator('[data-counter]').click();
    await rowPage.waitForFunction(() =>
      document.querySelector('[data-counter]')?.textContent?.includes('1'),
    );
    const incrementalBefore = await rowPage.$('[data-incremental-boundary]');
    assert.notEqual(incrementalBefore, null);
    await rowPage.locator('[data-incremental-action]').click();
    await rowPage.waitForFunction(
      () =>
        document
          .querySelector('[data-incremental-count]')
          ?.textContent?.trim() === '1',
    );
    assert.equal(
      await incrementalBefore.evaluate(
        (element) =>
          element === document.querySelector('[data-incremental-boundary]'),
      ),
      true,
    );
    assert.match(
      await rowPage.locator('[data-rich-message]').textContent(),
      /Read the guide/u,
    );
    assert.equal(await rowPage.locator('[data-inert-text] img').count(), 0);
    noteAwaiting(`${row.id} exerciseLocaleContinuity`);
    await exerciseLocaleContinuity(rowPage);
    noteAwaiting(`${row.id} assertDirectAccessibility`);
    await assertDirectAccessibility(rowPage);
    await rowPage.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(
      await rowPage.evaluate(
        () => globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches,
      ),
      true,
    );
    await rowPage.locator('[data-locale-choice="ar-EG"]').click();
    await rowPage.waitForFunction(
      () =>
        document.documentElement.lang === 'ar-EG' &&
        document.documentElement.dir === 'rtl',
    );
    await rowPage.locator('[data-locale-choice="en-US"]').click();
    await rowPage.waitForFunction(
      () =>
        document.documentElement.lang === 'en-US' &&
        document.documentElement.dir === 'ltr',
    );
    noteAwaiting(`${row.id} verifyRenderingModes`);
    await verifyRenderingModes(row, rowContext, diagnostics);
    noteAwaiting(`${row.id} verifySwitchEndurance`);
    await verifySwitchEndurance(rowPage, row);
    noteAwaiting(`${row.id} collectPolicyDiagnostics`);
    await collectPolicyDiagnostics(rowPage, diagnostics);
    assertBrowserDiagnostics(diagnostics, `${row.label} ${version}`);
    return {
      id: row.id,
      label: row.label,
      trustedTypes: await rowPage.evaluate(
        () => typeof globalThis.trustedTypes === 'object',
      ),
      version,
    };
  } catch (error) {
    try {
      if (rowPage !== undefined) {
        await collectPolicyDiagnostics(rowPage, diagnostics);
      }
    } catch (diagnosticError) {
      diagnostics.diagnosticError = String(diagnosticError);
    }
    // The cause is in the message, not only attached to it. Node prints a thrown Error's message
    // and stack; a `cause` reaches nobody unless something walks the chain, so a row carrying only
    // the cause reports that it failed without saying what failed.
    throw new Error(
      `${row.label} ${version} assurance row failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n${JSON.stringify(diagnostics, null, 2)}`,
      { cause: error },
    );
  } finally {
    await rowContext?.close();
    await rowBrowser.close();
  }
}

let browser;
let context;
let page;
let releaseScriptRequests = () => {};
let verificationFailure;
let verificationDiagnostics;
const consoleErrors = [];
const pageErrors = [];
const requestFailures = [];
const cspViolations = [];
/**
 * Every browser row, from before the first one starts, with how far each got.
 *
 * The failure block below is the only reader of this, and a row enters on the way in rather than
 * on the way out. A row recorded on the way out is a row that passed, so the block would describe
 * the engines that had already succeeded and say nothing about the one that had not, nor about the
 * ones that never started. Identity on entry, outcome on exit.
 */
const browserEvidence = browserRows.map((row) => ({
  id: row.id,
  label: row.label,
  outcome: 'not started',
}));

function browserRowEvidence(row) {
  const evidence = browserEvidence.find(({ id }) => id === row.id);
  assert.notEqual(
    evidence,
    undefined,
    `Browser assurance has no evidence entry for ${row.id}.`,
  );
  return evidence;
}
const chromiumDiagnostics = {
  cspViolations,
  consoleErrors,
  engine: 'chromium',
  pageErrors,
  requestFailures,
};

try {
  if (selfTest === 'diagnostics') {
    throw new Error('Self-test escape: a failure inside the verified run.');
  }

  enterStage('host-outcomes');
  // No remembered preference, and still not publicly cacheable.
  //
  // Making this `public` because the answer is the same for every visitor who
  // arrives without a cookie, which is true and is not the question. The two fetches below are the
  // question: they are the same URL, they get different answers, and a shared cache keys on the URL.
  // Whichever of them is stored public is the one every subsequent visitor receives.
  const localeEntry = await fetch(`${origin}/`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(localeEntry.status, 307);
  assert.equal(localeEntry.headers.get('location'), '/en-us');
  assert.equal(localeEntry.headers.get('cache-control'), 'private, no-store');
  // The same URL with a remembered preference. The visitor lands in Arabic instead of landing in
  // English and switching by hand, and this is the response that proves the one above cannot be
  // public. Different body, different `Location`, same cache key.
  const negotiatedEntry = await fetch(`${origin}/`, {
    redirect: 'manual',
    headers: { cookie: 'atlas-locale=ar-EG' },
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(negotiatedEntry.status, 307);
  assert.equal(negotiatedEntry.headers.get('location'), '/ar-eg');
  assert.equal(
    negotiatedEntry.headers.get('cache-control'),
    'private, no-store',
  );
  assert.notEqual(
    localeEntry.headers.get('location'),
    negotiatedEntry.headers.get('location'),
    'Both entry fetches produced the same address, so this run proves nothing about two answers sharing one cache key.',
  );
  // A preference for a language this application does not offer is ignored rather than turned
  // into an error about a URL that was perfectly valid.
  const unusableEntry = await fetch(`${origin}/`, {
    redirect: 'manual',
    headers: { cookie: 'atlas-locale=zz-ZZ' },
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(unusableEntry.status, 307);
  assert.equal(unusableEntry.headers.get('location'), '/en-us');
  // And a preference for a locale this policy *does* address, which this build did not generate.
  // `zz-ZZ` above was refused by the policy alone and proves nothing about the build; `en-Arab-XB`
  // has a prefix written for it in `localization.routes.ts` and exists only under
  // `atlas generate --pseudo`. Until the served policy was narrowed to the generated locale set
  // this answered `/en-arab-xb`, and the address behind it rendered as a success in markup
  // labelled `lang="en-Arab-XB"` with English text inside it (4.16).
  const unbuiltEntry = await fetch(`${origin}/`, {
    redirect: 'manual',
    headers: { cookie: 'atlas-locale=en-Arab-XB' },
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(unbuiltEntry.status, 307);
  assert.equal(unbuiltEntry.headers.get('location'), '/en-us');
  // The address directly, which is the half no preference check reaches: a link, a bookmark, or a
  // crawler that read the prefix somewhere and came back for it.
  const unbuiltAddress = await fetch(`${origin}/en-arab-xb/second`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(unbuiltAddress.status, 404);
  // The control for both, in the same shape and through the same policy: a locale this build does
  // have still answers at its own address, so neither assertion above is passing because the
  // application stopped resolving anything.
  const builtAddress = await fetch(`${origin}/ar-eg/second`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(builtAddress.status, 200);
  assert.equal(builtAddress.headers.get('content-language'), 'ar-EG');
  // The cache header on a 200, which nothing in this file had ever read.
  //
  // That gap is why the fixture's `successMaxAge: 0` went unnoticed twice. A zero makes every
  // `public` response revalidate on every request, so it behaves privately, so a classification
  // that should have been private and was not looks exactly like one that is right. Two separate
  // defects (locale entry, and a locale-neutral 200) were each safe here by that accident
  // rather than by the design, and neither could have been caught by a gate that reads the
  // classification's consequences only for redirects.
  //
  // The fixture now sets 600, and this pins what falls out. `/ar-eg/second` states its own locale,
  // so it is the same document for every visitor and `public` is the right answer: this is the
  // control that keeps the varying classification from quietly spreading to addresses that do not
  // vary. `Vary` must be absent for the same reason.
  assert.equal(
    builtAddress.headers.get('cache-control'),
    'public, max-age=600, must-revalidate',
  );
  assert.equal(builtAddress.headers.get('vary'), null);
  const correction = await fetch(`${origin}/EN-US/Second/`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(correction.status, 308);
  assert.equal(correction.headers.get('location'), '/en-us/second');
  assert.equal(
    correction.headers.get('cache-control'),
    'public, max-age=86400',
  );
  const historicalReplacement = await fetch(`${origin}/en-us/legacy?tab=one`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(historicalReplacement.status, 308);
  assert.equal(
    historicalReplacement.headers.get('location'),
    '/en-us/second?tab=one',
  );
  const historicalGone = await fetch(`${origin}/ar-eg/removed`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(historicalGone.status, 410);
  assert.equal(historicalGone.headers.get('content-language'), 'ar-EG');
  assert.equal(historicalGone.headers.get('x-robots-tag'), 'noindex');
  assert.equal(
    historicalGone.headers.get('cache-control'),
    'private, no-store',
  );
  const malformed = await fetch(`${origin}/en-us//second`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get('content-language'), 'en-US');
  assert.equal(malformed.headers.get('x-robots-tag'), 'noindex');
  assert.equal(malformed.headers.get('cache-control'), 'private, no-store');
  const unsupported = await fetch(`${origin}/fr/second`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(unsupported.status, 404);
  assert.equal(unsupported.headers.get('content-language'), 'en-US');
  assert.equal(unsupported.headers.get('x-robots-tag'), 'noindex');
  const nonIndexable = await fetch(`${origin}/en-us/items/42`, {
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(nonIndexable.status, 200);
  assert.equal(nonIndexable.headers.get('content-language'), 'en-US');
  assert.equal(nonIndexable.headers.get('x-robots-tag'), 'noindex');
  const prerendered = await fetch(`${origin}/en-us/second`, {
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(prerendered.status, 200);
  assert.equal(prerendered.headers.get('content-language'), 'en-US');
  const prerenderedDocument = new JSDOM(await prerendered.text()).window
    .document;
  assert.equal(
    prerenderedDocument
      .querySelector('link[rel="canonical"]')
      ?.getAttribute('href'),
    'https://atlas.example/en-us/second',
  );
  const articleAlias = await fetch(`${origin}/ar-eg/articles/atlas-handbook`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(articleAlias.status, 308);
  assert.equal(
    articleAlias.headers.get('location'),
    '/ar-eg/articles/%D8%AF%D9%84%D9%8A%D9%84-%D8%A3%D8%B7%D9%84%D8%B3',
  );

  // Follow it. Asserting the redirect and stopping there proves Atlas can name the address, not
  // that anything serves it, and this is precisely the address that does not serve itself.
  //
  // The build writes the page at the decoded spelling on disk while the browser asks for it encoded.
  // `@angular/ssr` 22.1.5 looked it up without decoding, so its key stayed percent-encoded and missed
  // the asset the same build produced: every ASCII address in this fixture served 200 with
  // `ng-server-context="ssg"` while the Arabic ones returned 404, with the file on disk at the right
  // address the whole time. 22.1.7 decodes first (`baf1ca1`, `ssr.mjs:1379-1382`), and re-measured on
  // the bump this address is served by the engine from its own prerendered file: 200,
  // `ng-server-context="ssg"`, the fixture's directory fallback never reached.
  //
  // The assertion does not move with the version. It says the address serves, in the language it
  // claims, from whichever half of this deployment answers, which is the deployment requirement in
  // section 9.1 measured rather than written down, and it held on both versions for different
  // reasons. A check written against the mechanism would have gone green here and told nobody that
  // the mechanism changed.
  const encodedArticle = await fetch(
    `${origin}/ar-eg/articles/%D8%AF%D9%84%D9%8A%D9%84-%D8%A3%D8%B7%D9%84%D8%B3`,
    { signal: AbortSignal.timeout(15_000) },
  );
  assert.equal(
    encodedArticle.status,
    200,
    'the prerendered non-ASCII address is not served',
  );
  const encodedDocument = new JSDOM(await encodedArticle.text()).window
    .document;
  assert.equal(encodedDocument.documentElement.lang, 'ar-EG');
  assert.equal(
    encodedDocument.title,
    '\u062f\u0644\u064a\u0644 \u0623\u0637\u0644\u0633 \u0644\u0644\u062a\u0631\u062c\u0645\u0629',
  );
  assert.equal(
    encodedDocument
      .querySelector('link[rel="canonical"]')
      ?.getAttribute('href'),
    'https://atlas.example/ar-eg/articles/%D8%AF%D9%84%D9%8A%D9%84-%D8%A3%D8%B7%D9%84%D8%B3',
  );
  const articleResponse = await fetch(
    `${origin}/en-us/articles/atlas-handbook`,
    { signal: AbortSignal.timeout(15_000) },
  );
  assert.equal(articleResponse.status, 200);
  const articleDocument = new JSDOM(await articleResponse.text()).window
    .document;
  assert.equal(articleDocument.title, 'The Atlas localization handbook');
  assert.equal(
    articleDocument
      .querySelector('meta[name="description"]')
      ?.getAttribute('content'),
    'Consumer-owned content coordinated through metadata only.',
  );
  assert.equal(
    articleDocument
      .querySelector('link[rel="canonical"]')
      ?.getAttribute('href'),
    'https://atlas.example/en-us/articles/atlas-handbook',
  );
  assert.deepEqual(
    [...articleDocument.querySelectorAll('link[rel="alternate"]')].map(
      (node) => [node.getAttribute('hreflang'), node.getAttribute('href')],
    ),
    [
      ['en-US', 'https://atlas.example/en-us/articles/atlas-handbook'],
      [
        'ar-EG',
        'https://atlas.example/ar-eg/articles/%D8%AF%D9%84%D9%8A%D9%84-%D8%A3%D8%B7%D9%84%D8%B3',
      ],
      ['x-default', 'https://atlas.example/'],
    ],
  );

  // The sitemap, fetched from the running build rather than derived beside it.
  //
  // Three claims, and the third is the one this exists for. Every address the file publishes is
  // served by this site: fetched, one by one, and answered 200 in the language it claims. The file
  // validates as a document. And the alternates it carries for a page are the alternates that
  // page's own head carries, element for element, because both come from `projectRouteSeo` and
  // there is no second derivation to drift.
  const sitemapResponse = await fetch(`${origin}/sitemap.xml`, {
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(sitemapResponse.status, 200);
  assert.match(
    sitemapResponse.headers.get('content-type') ?? '',
    /^application\/xml/u,
    'the sitemap is not served as XML',
  );
  const sitemapText = await sitemapResponse.text();
  const sitemapDocument = new JSDOM(sitemapText, {
    contentType: 'text/xml',
  }).window.document;

  const publishedUrls = [...sitemapDocument.querySelectorAll('url')].map(
    (entry) => entry.querySelector('loc')?.textContent ?? '',
  );
  // The two parameterless indexable routes and the one article, in two locales each. `items` is
  // non-indexable and `lazy` is not published, so neither is here: the indexing class does in a
  // sitemap what it does in the head.
  assert.deepEqual(
    publishedUrls,
    [
      'https://atlas.example/en-us/second',
      'https://atlas.example/ar-eg/second',
      'https://atlas.example/en-us/articles/atlas-handbook',
      'https://atlas.example/ar-eg/articles/%D8%AF%D9%84%D9%8A%D9%84-%D8%A3%D8%B7%D9%84%D8%B3',
      'https://atlas.example/en-us',
      'https://atlas.example/ar-eg',
    ],
    `the sitemap publishes the wrong set of addresses:\n${publishedUrls.join('\n')}`,
  );

  // What the routes claim, read out of the served file. `second` is `reference`, which the
  // declaration in `app.config.ts` maps to monthly at 0.5, and it declares its own `updated` date.
  // The article's class is not in that table, so it claims nothing, and its entry is complete
  // without one.
  const secondEntry = [...sitemapDocument.querySelectorAll('url')].find(
    (entry) =>
      entry.querySelector('loc')?.textContent ===
      'https://atlas.example/en-us/second',
  );
  assert.equal(
    secondEntry?.querySelector('lastmod')?.textContent,
    '2026-09-01',
  );
  assert.equal(
    secondEntry?.querySelector('changefreq')?.textContent,
    'monthly',
  );
  assert.equal(secondEntry?.querySelector('priority')?.textContent, '0.5');
  const articleEntry = [...sitemapDocument.querySelectorAll('url')].find(
    (entry) =>
      entry.querySelector('loc')?.textContent ===
      'https://atlas.example/en-us/articles/atlas-handbook',
  );
  assert.equal(articleEntry?.querySelector('changefreq'), null);
  assert.equal(articleEntry?.querySelector('priority'), null);

  // The head and the sitemap, compared rather than each written out. `articleDocument` above is
  // the page this site served at that address; these are the links the same site published for it.
  assert.deepEqual(
    [...(articleEntry?.getElementsByTagName('xhtml:link') ?? [])].map(
      (node) => [node.getAttribute('hreflang'), node.getAttribute('href')],
    ),
    [...articleDocument.querySelectorAll('link[rel="alternate"]')].map(
      (node) => [node.getAttribute('hreflang'), node.getAttribute('href')],
    ),
    'the sitemap and the head advertise different alternates',
  );

  // Every entry served. The file states the site's own origin and the harness reaches it on a
  // loopback port, so the path is what is fetched, which is the same substitution a reader makes.
  //
  // Read out of the page rather than off the response headers, for the reason the encoded article
  // above gives: this deployment has two halves that answer, and which one answers an address
  // moves with the engine's version. The prerendered file carries the language on the document and
  // no robots meta, whichever half hands it over; `Content-Language` and `X-Robots-Tag` are set by
  // the half that runs Atlas. So a header assertion here would be a claim about the plumbing, and
  // what the sitemap promises is a page: at this address, in this language, open to a crawler.
  for (const published of publishedUrls) {
    const path = new URL(published).pathname;
    const served = await fetch(`${origin}${path}`, {
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(
      served.status,
      200,
      `${published} is published and not served`,
    );
    const servedDocument = new JSDOM(await served.text()).window.document;
    assert.equal(
      servedDocument.documentElement.lang,
      path.split('/')[1] === 'ar-eg' ? 'ar-EG' : 'en-US',
      `${published} is served in the wrong language`,
    );
    // Atlas writes this element only for a page it classes out of the index, so its absence is the
    // assertion. An indexable page carries no robots meta at all.
    assert.equal(
      servedDocument.querySelector('meta[name="robots"]'),
      null,
      `${published} is published in the sitemap and refused to crawlers`,
    );
  }

  enterStage('parallel-ssr');
  const [alphaHtml, bravoHtml, titledHtml, dossierHtml] = await Promise.all([
    render('alpha-request', 'en-US'),
    render('bravo-request', 'ar-EG'),
    // 8.2. The one route in this application that declares a `title` in its route config, rendered
    // under a locale whose title is not that string.
    //
    // `second` declares `'Second route, declared in English'`. Angular's `DefaultTitleStrategy`
    // writes a declared title after `NavigationEnd`, which is after Atlas has written the localized
    // one, so on a server render this is where the two writers meet. The provider line in
    // `app.config.ts` is what decides it: take it out and this document says the English string
    // under `lang="ar-EG"`, with nothing thrown and nothing logged.
    render('titled-request', 'ar-EG', '/second'),
    // 8.4. The route whose slug no codec can translate, server-rendered.
    //
    // `dossierSlugCodec` is identity, so left to itself Atlas advertises the English slug under the
    // Arabic prefix. The page's component loads the record and declares the per-locale spellings,
    // and this is the only place that proves the declaration survives a server render: it lands
    // on a promise after the route activates, so a render that serialized the head before the
    // application went stable would ship the codec's answer and look entirely normal.
    render('dossier-request', 'en-US', '/dossiers/atlas-dossier'),
  ]);
  const alpha = readSnapshot(alphaHtml);
  const bravo = readSnapshot(bravoHtml);

  assert.equal(alpha.document.documentElement.lang, 'en-US');
  assert.equal(alpha.document.documentElement.dir, 'ltr');
  assert.equal(alpha.document.title, 'Atlas feature lab');
  assert.equal(
    alpha.document
      .querySelector('meta[name="description"]')
      ?.getAttribute('content'),
    'Atlas localization runtime feature laboratory.',
  );
  assert.equal(
    alpha.document.querySelector('link[rel="canonical"]')?.getAttribute('href'),
    'https://atlas.example/en-us',
  );
  assert.deepEqual(
    [...alpha.document.querySelectorAll('link[rel="alternate"]')].map((node) =>
      node.getAttribute('hreflang'),
    ),
    ['en-US', 'ar-EG', 'x-default'],
  );
  assert.match(
    alpha.document.querySelector('h1')?.textContent ?? '',
    /Atlas feature lab/,
  );
  assert.equal(
    alpha.document
      .querySelector('[data-incremental-message]')
      ?.textContent?.trim(),
    'Incremental localization boundary ready.',
  );
  assert.equal(bravo.document.documentElement.lang, 'ar-EG');
  assert.equal(bravo.document.documentElement.dir, 'rtl');
  assert.equal(bravo.document.title, 'مختبر ميزات Atlas');

  // Asserted on the rendered document, and asserted twice: what the title is, and what it is not.
  // The second is the load-bearing one: the failure mode is a *different valid title*, not a
  // missing one, so an assertion that the title is non-empty would be green for the defect.
  const titled = readSnapshot(titledHtml);
  assert.equal(titled.document.documentElement.lang, 'ar-EG');
  assert.equal(
    titled.document
      .querySelector('[data-route-view]')
      ?.getAttribute('data-route-view'),
    'second',
    'the titled route did not render, so its title proves nothing',
  );
  // 8.3. This route's own title, from the Arabic catalog, keyed by its route id. Not the home
  // page's title, which is what an application serves when the strategy keys on nothing, and not
  // the English string its route config declares, which is what Angular writes on its own.
  // Three distinct strings, so this assertion cannot pass by accident on any of the three paths.
  assert.equal(titled.document.title, 'العنوان الثاني');
  assert.notEqual(
    titled.document.title,
    'Second route, declared in English',
    'Angular wrote the route-declared title over the localized one',
  );
  assert.notEqual(
    titled.document.title,
    bravo.document.title,
    'the titled route served the home page metadata, so route ids are not being read',
  );
  assert.equal(
    titled.document
      .querySelector('meta[name="description"]')
      ?.getAttribute('content'),
    'عنوان ثانٍ، لإثبات أن بيانات كل صفحة خاصة بها.',
  );
  const dossier = readSnapshot(dossierHtml);
  assert.equal(
    dossier.document
      .querySelector('[data-route-view]')
      ?.getAttribute('data-entity-id'),
    'atlas-dossier',
    'the dossier route did not load its record, so its address proves nothing',
  );
  const dossierAlternate = (hreflang) =>
    dossier.document
      .querySelector(`link[rel="alternate"][hreflang="${hreflang}"]`)
      ?.getAttribute('href');
  assert.equal(
    dossierAlternate('ar-EG'),
    `https://atlas.example/ar-eg/dossiers/${encodeURIComponent('ملف-أطلس')}`,
  );
  // The codec's own answer, stated so this cannot pass by falling back to it.
  assert.notEqual(
    dossierAlternate('ar-EG'),
    'https://atlas.example/ar-eg/dossiers/atlas-dossier',
  );
  assert.equal(
    dossier.document
      .querySelector('link[rel="canonical"]')
      ?.getAttribute('href'),
    'https://atlas.example/en-us/dossiers/atlas-dossier',
  );
  assert.match(
    bravo.document.querySelector('h1')?.textContent ?? '',
    /مختبر ميزات Atlas/,
  );
  assert.equal(
    bravo.document
      .querySelector('[data-incremental-message]')
      ?.textContent?.trim(),
    'حد الترجمة التدريجي جاهز.',
  );
  // 8.1. Open Graph, on a server-rendered Arabic page, in the spelling ogp.me specifies.
  //
  // The failure this is written against is the one a hand-written implementation produces: the
  // runtime locale emitted unchanged, so the tag reads `ar-EG`. That is valid BCP 47, it matches
  // every other locale-shaped value in this document, and ogp.me says "Of the format
  // `language_TERRITORY`". Asserted on the rendered document rather than on the helper, because the
  // helper being right does not prove the head carries what it returned.
  const openGraph = (snapshot, name) =>
    [...snapshot.document.querySelectorAll(`meta[property="${name}"]`)].map(
      (node) => node.getAttribute('content'),
    );

  assert.deepEqual(openGraph(bravo, 'og:locale'), ['ar_EG']);
  assert.deepEqual(openGraph(bravo, 'og:locale:alternate'), ['en_US']);
  assert.deepEqual(openGraph(alpha, 'og:locale'), ['en_US']);
  assert.deepEqual(openGraph(alpha, 'og:locale:alternate'), ['ar_EG']);

  // The page's own locale must not also be listed as an alternate: that would say the page is
  // available in the language it is written in.
  for (const [snapshot, own] of [
    [alpha, 'en_US'],
    [bravo, 'ar_EG'],
  ]) {
    assert.equal(
      openGraph(snapshot, 'og:locale:alternate').includes(own),
      false,
      `${own} is listed as an alternate of itself`,
    );
  }

  // Open Graph is addressed by `property`. A block written with `name` is silently ignored by the
  // crawler it was written for, and nothing about it looks wrong, so the attribute is pinned.
  assert.equal(
    bravo.document.querySelectorAll('meta[name="og:locale"]').length,
    0,
    'Open Graph tags must use property=, not name=',
  );
  // And the card tag is the other way round, which is why both are checked.
  assert.equal(
    bravo.document
      .querySelector('meta[name="twitter:card"]')
      ?.getAttribute('content'),
    'summary_large_image',
  );
  assert.equal(
    bravo.document.querySelectorAll('meta[property="twitter:card"]').length,
    0,
    'card tags must use name=, not property=',
  );

  // The rest of the block, including the four ogp.me calls required, and the description in Arabic
  // rather than the source locale.
  assert.deepEqual(openGraph(bravo, 'og:title'), ['مختبر ميزات Atlas']);
  assert.deepEqual(openGraph(bravo, 'og:type'), ['website']);
  assert.deepEqual(openGraph(bravo, 'og:image'), [
    'https://atlas.example/social/preview.png',
  ]);
  assert.deepEqual(openGraph(bravo, 'og:url'), ['https://atlas.example/ar-eg']);

  assert.equal(alpha.label, 'alpha-request');
  assert.equal(bravo.label, 'bravo-request');
  assert.equal(alpha.source, 'server-transfer');
  assert.equal(bravo.source, 'server-transfer');
  assert.equal(alpha.locale, 'en-US');
  assert.equal(bravo.locale, 'ar-EG');
  // The addresses travel, and they have to: the server rendered a switcher with them in its links,
  // and a client that hydrated without them would blank those links until the first navigation.
  //
  // They carry the reader's query, and the alternates in the same document do not: `?label=` is
  // this harness's own request marker and stands in for any query a reader arrives with. One
  // derivation, two readers, each forming its own string: a canonical URL states where the page
  // lives and omits the query by `specs/07-routing-rendering-and-seo.spec.md` section 10, and a
  // switch moves the reader to the page they are actually on.
  //
  // `en-Arab-XB` is absent because this server build generated no pseudo-locale, so the policy the
  // adapter holds no longer addresses it. The narrowing is the policy's, not a rule of its own.
  assert.deepEqual(alpha.transfer.route, {
    routeId: 'route:_index',
    projectionIdentity: alpha.transfer.route.projectionIdentity,
    canonicalPath: '/en-us',
    addresses: {
      'en-US': '/en-us?label=alpha-request',
      'ar-EG': '/ar-eg?label=alpha-request',
    },
  });
  assert.match(
    alpha.transfer.route.projectionIdentity,
    /^sha256-[A-Za-z0-9_-]{43}$/u,
  );
  assert.deepEqual(bravo.transfer.route, {
    routeId: 'route:_index',
    projectionIdentity: alpha.transfer.route.projectionIdentity,
    canonicalPath: '/ar-eg',
    addresses: {
      'en-US': '/en-us?label=bravo-request',
      'ar-EG': '/ar-eg?label=bravo-request',
    },
  });
  assert.equal(alpha.transfer.formatting.locale, 'en-US');
  assert.equal(bravo.transfer.formatting.locale, 'ar-EG');
  assert.deepEqual(alpha.transfer.participants, [
    {
      profile: 'atlas-participant-state/1',
      participantId: 'feature-article',
      coordination: 'required',
      current: {
        targetLocale: 'en-US',
        transitionId: 0,
        report: {
          status: 'ready',
          representation: {
            kind: 'locale-bound',
            supplyingLocale: 'en-US',
            direction: 'ltr',
          },
          identity: {
            resourceId: 'article:atlas-handbook',
            representationId: 'article-en',
            revision: 'a-1',
            correlationId: 'source-a:en-US:a-1',
          },
        },
      },
      attempt: {
        status: 'ready',
        targetLocale: 'en-US',
        transitionId: 0,
        report: {
          status: 'ready',
          representation: {
            kind: 'locale-bound',
            supplyingLocale: 'en-US',
            direction: 'ltr',
          },
          identity: {
            resourceId: 'article:atlas-handbook',
            representationId: 'article-en',
            revision: 'a-1',
            correlationId: 'source-a:en-US:a-1',
          },
        },
      },
    },
  ]);
  assert.equal(bravo.transfer.participants[0]?.current?.targetLocale, 'ar-EG');
  assert.equal(
    bravo.transfer.participants[0]?.current?.report?.representation
      ?.supplyingLocale,
    'ar-EG',
  );
  assert.equal(
    JSON.stringify(alpha.transfer).includes('consumer-owned-dynamic-payload'),
    false,
    'Atlas TransferState retained consumer payload',
  );
  assert.equal(
    JSON.stringify(alpha.transfer).includes('The Atlas localization handbook'),
    false,
    'Atlas TransferState retained consumer article text',
  );
  assert.equal(
    alpha.dynamicTransfer.article.payloadMarker,
    'consumer-owned-dynamic-payload',
  );
  assert.equal(
    alpha.dynamicTransfer.article.title,
    'The Atlas localization handbook',
  );
  assert.equal(alpha.dynamicTransfer.article.supplyingLocale, 'en-US');
  assert.equal(bravo.dynamicTransfer.article.supplyingLocale, 'ar-EG');
  assert.equal(
    alpha.document.querySelector('[data-dynamic-title]')?.textContent?.trim(),
    'The Atlas localization handbook',
  );
  assert.equal(
    bravo.document.querySelector('[data-dynamic-title]')?.textContent?.trim(),
    'دليل أطلس للترجمة',
  );
  // An attribute-position label has to be in the server's HTML, not written on hydration. A
  // crawler and a screen reader on a page that has not hydrated read the markup as delivered.
  assert.equal(
    alpha.document.querySelector('[data-label]')?.getAttribute('aria-label'),
    'Atlas feature lab',
  );
  assert.equal(
    bravo.document.querySelector('[data-label]')?.getAttribute('aria-label'),
    'مختبر ميزات Atlas',
  );
  assert.equal(
    alpha.document.querySelector('[data-label-alt]')?.getAttribute('alt'),
    'static alt',
  );
  assert.notEqual(alpha.requestId, bravo.requestId);
  assert.equal(alphaHtml.includes('bravo-request'), false);
  assert.equal(bravoHtml.includes('alpha-request'), false);

  enterStage('ssr-endurance');
  const enduranceRows = Array.from({ length: 32 }, (_, index) => ({
    label: `endurance-${String(index).padStart(2, '0')}`,
    locale: index % 2 === 0 ? 'en-US' : 'ar-EG',
  }));
  const enduranceHtml = await Promise.all(
    enduranceRows.map((row) => render(row.label, row.locale)),
  );
  const enduranceSnapshots = enduranceHtml.map(readSnapshot);
  assert.equal(
    new Set(enduranceSnapshots.map((snapshot) => snapshot.requestId)).size,
    enduranceRows.length,
    'Parallel SSR reused request identities',
  );
  for (const [index, row] of enduranceRows.entries()) {
    const snapshot = enduranceSnapshots[index];
    const html = enduranceHtml[index];
    assert.notEqual(snapshot, undefined);
    assert.notEqual(html, undefined);
    assert.equal(snapshot.label, row.label);
    assert.equal(snapshot.locale, row.locale);
    assert.equal(snapshot.source, 'server-transfer');
    assert.equal(snapshot.document.documentElement.lang, row.locale);
    assert.equal(
      snapshot.document.documentElement.dir,
      row.locale === 'ar-EG' ? 'rtl' : 'ltr',
    );
    assert.equal(snapshot.transfer.participants.length, 1);
    assert.ok(
      snapshot.transfer.participants.length <= 128,
      'SSR participant state exceeded its explicit bound',
    );
    assert.equal(
      JSON.stringify(snapshot.transfer).includes(
        'consumer-owned-dynamic-payload',
      ),
      false,
      'Atlas TransferState retained consumer payload during endurance',
    );
    assert.equal(
      snapshot.dynamicTransfer.article.payloadMarker,
      'consumer-owned-dynamic-payload',
    );
    for (const other of enduranceRows) {
      if (other.label !== row.label) {
        assert.equal(
          html.includes(other.label),
          false,
          `${row.label} SSR output leaked ${other.label}`,
        );
      }
    }
  }

  enterStage('browser-launch');
  const chromiumRow = browserRows[0];
  assert.notEqual(chromiumRow, undefined);
  const chromiumEvidence = browserRowEvidence(chromiumRow);
  chromiumEvidence.outcome = 'started';
  browser = await launchBrowserRow(chromiumRow);
  const chromiumVersion = browser.version();
  chromiumEvidence.version = chromiumVersion;
  context = boundCalls(await browser.newContext(), 'context');
  await installStrictBrowserPolicy(context);
  page = boundCalls(await context.newPage(), 'page');
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(20_000);

  // The primary row feeds the same account as the secondary ones, so a bound tripping in any stage
  // describes what the row was doing rather than only naming the stage.
  page.on('framenavigated', (frame) =>
    noteActivity(`navigated ${frame.url()}`),
  );
  page.on('load', () => noteActivity('load'));
  if (traceRequests) {
    page.on('request', (request) => {
      rowActivity.inFlight.set(request.url(), Date.now());
      noteActivity(`request ${request.resourceType()}`);
    });
    page.on('requestfinished', (request) => {
      rowActivity.inFlight.delete(request.url());
      noteActivity('requestfinished');
    });
  }
  page.on('console', (message) => {
    noteActivity(`console ${message.type()}`);
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    noteActivity('pageerror');
    pageErrors.push(error.message);
  });
  page.on('requestfailed', (request) => {
    if (
      request.url().startsWith(origin) &&
      criticalBrowserResourceTypes.has(request.resourceType())
    ) {
      requestFailures.push(
        `${request.url()}: ${request.failure()?.errorText ?? 'unknown failure'}`,
      );
    }
  });

  let releaseScripts;
  const scriptGate = new Promise((resolveGate) => {
    releaseScripts = resolveGate;
  });
  releaseScriptRequests = releaseScripts;

  await page.route('**/*.js', async (route) => {
    await scriptGate;
    await route.continue();
  });

  enterStage('hydration-navigation');
  const navigation = page.goto(`${origin}/en-us?label=hydration-request`, {
    waitUntil: 'load',
  });
  await page.waitForSelector(
    '[data-ssr-probe][data-label="hydration-request"]',
    { state: 'attached' },
  );

  const rootBefore = await page.$('app-root');
  const headingBefore = await page.$('h1');
  const probeBefore = await page.$('[data-ssr-probe]');
  assert.notEqual(rootBefore, null, 'SSR root is absent before hydration');
  assert.notEqual(
    headingBefore,
    null,
    'SSR heading is absent before hydration',
  );
  assert.notEqual(probeBefore, null, 'SSR probe is absent before hydration');
  assert.equal(
    await page.locator('html').getAttribute('data-client-ready'),
    null,
  );

  enterStage('hydration-adoption');
  releaseScripts();
  const hydrationResponse = await navigation;
  const chromiumTrustedTypes = await assertTrustedTypesPolicy(
    page,
    hydrationResponse,
    chromiumRow,
  );
  await page.waitForFunction(
    () => document.documentElement.dataset['clientReady'] === 'true',
  );

  assert.equal(
    await page.locator('html').getAttribute('data-transfer-source'),
    'server-transfer',
  );
  assert.equal(
    await rootBefore.evaluate(
      (element) => element === document.querySelector('app-root'),
    ),
    true,
    'Hydration replaced the root element',
  );
  assert.equal(
    await headingBefore.evaluate(
      (element) => element === document.querySelector('h1'),
    ),
    true,
    'Hydration replaced the localized heading',
  );
  assert.equal(
    await probeBefore.evaluate(
      (element) => element === document.querySelector('[data-ssr-probe]'),
    ),
    true,
    'Hydration replaced the transferred snapshot element',
  );
  assert.equal(
    await page.locator('[data-ssr-probe]').getAttribute('data-source'),
    'server-transfer',
  );
  assert.equal(
    await page.locator('[data-ssr-probe]').getAttribute('data-label'),
    'hydration-request',
  );
  assert.equal(
    await page
      .locator('[data-dynamic-content]')
      .getAttribute('data-source-requests'),
    '0',
    'Hydration reacquired consumer payload instead of adopting its own transfer',
  );
  assert.equal(
    await page.locator('[data-dynamic-title]').textContent(),
    'The Atlas localization handbook',
  );
  assert.equal(
    await page
      .locator('[data-dynamic-content]')
      .getAttribute('data-participant-status'),
    'ready',
  );

  enterStage('event-replay');
  await page.locator('[data-counter]').click();
  await page.waitForFunction(() =>
    document.querySelector('[data-counter]')?.textContent?.includes('count 1'),
  );

  enterStage('localized-not-found');
  {
    // An address this application does not serve, under a locale it does. The locale resolved
    // perfectly well; only the page is unknown, and the application's own not-found route is what
    // answers. Treating that as a localization failure abandoned the navigation and rendered
    // nothing at all.
    const missing = boundCalls(await context.newPage(), 'page');
    missing.setDefaultTimeout(15_000);
    await missing.goto(`${origin}/ar-eg/no-such-page`, {
      waitUntil: 'networkidle',
    });
    await missing.waitForFunction(
      () => document.querySelector('[data-route-view="not-found"]') !== null,
      undefined,
      { timeout: 10_000 },
    );
    assert.equal(
      await missing.evaluate(() => document.documentElement.lang),
      'ar-EG',
      'A not-found under a locale prefix did not answer in that locale',
    );
    await missing.close();

    // The same address without a prefix, which is what an ordinary hand-written `href` produces.
    // Locale entry has to be offered for an address the projection does not know, exactly as it is
    // for one it knows. Answered as not-found where it stands, under a prefix policy nothing is
    // mounted there, so the outlet renders empty and the document takes no title.
    //
    // The path deliberately opens with a segment no language tag can be: `/no-such-page` would
    // not test this, because `no` is Norwegian and `no-such-page` parses as a language tag, so
    // Atlas reads it as intent toward an unsupported locale and answers 404 where it stands.
    const unprefixed = boundCalls(await context.newPage(), 'page');
    unprefixed.setDefaultTimeout(15_000);
    await unprefixed.goto(`${origin}/nothing-is-mounted-here`, {
      waitUntil: 'networkidle',
    });
    await unprefixed.waitForFunction(
      () => document.querySelector('[data-route-view="not-found"]') !== null,
      undefined,
      { timeout: 10_000 },
    );
    assert.equal(
      new URL(unprefixed.url()).pathname,
      '/en-us/nothing-is-mounted-here',
      'An address with no locale prefix was not sent to one before answering',
    );
    assert.ok(
      (await unprefixed.title()).length > 0,
      'The not-found page reached without a prefix has no document title',
    );
    await unprefixed.close();
  }

  enterStage('route-deferred-scope');
  {
    // A scope used nowhere but behind a lazy route boundary, reached by navigating to the route
    // that defers it. Nothing here preloads anything: the generated route table names the scopes
    // that route must have ready and the Router adapter loads them on activation.
    //
    // This stage exists because that derivation was covered by nothing. The unit tests load the
    // scope by calling `preloadScope` themselves and the Router adapter's test declares its scopes
    // through `requiredScopes`, so both prove the loading API works when something calls it, not
    // that a route causes it. Deleting the derivation entirely left every gate passing, which is
    // how a page that rendered no text reached a release.
    //
    // Both locales, directly rather than through a transition, because the derived list carries
    // the startup scopes as well: a route that renders in one locale and not the other is the
    // shape the omission took.
    for (const [prefix, expected] of [
      ['en-us', 'Lazy scope ready.'],
      ['ar-eg', 'النطاق الكسول جاهز.'],
    ]) {
      const deferred = boundCalls(await context.newPage(), 'page');
      deferred.setDefaultTimeout(15_000);
      await deferred.goto(`${origin}/${prefix}/lazy`, {
        waitUntil: 'networkidle',
      });
      await deferred.waitForFunction(
        () => document.querySelector('[data-route-view="lazy"]') !== null,
        undefined,
        { timeout: 10_000 },
      );
      assert.equal(
        (
          await deferred.locator('[data-route-view="lazy"]').textContent()
        )?.trim(),
        expected,
        `The scope deferred behind /${prefix}/lazy did not load when that route activated`,
      );
      await deferred.close();
    }
  }

  enterStage('incremental-hydration-after-locale-change');
  {
    // The order that would break hydration if anything did. A deferred block is still inert server
    // HTML, written in the render locale, when the locale commits, and hydration adopts that DOM
    // rather than writing it. What this asserts is that adoption is not the end of the story: the
    // ordinary update pass runs over the claimed DOM and writes the committed locale into it.
    //
    // Atlas shipped a `LocalizedDeferredContent` directive that cleared the container first, on the
    // premise that a claimed block would read English inside an Arabic page forever. That premise is
    // false (measured across eight binding kinds, every one corrected) and the
    // clear was a no-op besides, because `ViewContainerRef.clear()` iterates live views and a
    // dehydrated view is not one. The directive is gone; this stage is what actually holds the
    // invariant, and it held identically before and after the removal.
    const probe = boundCalls(await context.newPage(), 'page');
    probe.setDefaultTimeout(15_000);
    await probe.goto(origin, { waitUntil: 'networkidle' });
    await probe.locator('[data-locale-choice="ar-EG"]').click();
    await probe.waitForFunction(
      () => document.documentElement.lang === 'ar-EG',
    );
    await probe.locator('[data-incremental-action]').click();
    await probe.waitForFunction(
      () =>
        document
          .querySelector('[data-incremental-message]')
          ?.textContent?.includes('حد الترجمة التدريجي جاهز.') === true,
      undefined,
      { timeout: 10_000 },
    );
    // The click that triggered hydration is also a click on the button inside the block, and it
    // still lands. Rebuilding the content in the committed locale must not cost the interaction
    // that asked for it.
    //
    // Waited for rather than read once, and the two are not interchangeable. The wait above is on
    // the *message*, and the count is written by a different pass; reading it immediately afterwards
    // asked whether the count had already landed, not whether it lands. In measurement the
    // count is '0' at the first sample and '1' from roughly 50ms onward, stable for the remaining
    // two seconds, so the read-once form was a coin toss that had been landing heads. It started
    // landing tails when the Angular-free core became its own entry point and shifted when the
    // click handler is wired, which changed the timing without changing the behaviour.
    //
    // The failure names the value it actually found, because 'expected 1' on its own cannot tell a
    // lost interaction from one that had not arrived yet, and that distinction is the whole
    // question this stage exists to answer.
    const expectedCount = '1';
    await probe
      .waitForFunction(
        (expected) =>
          document.querySelector('[data-incremental-count]')?.textContent ===
          expected,
        expectedCount,
        { timeout: 10_000 },
      )
      .catch(async () => {
        const found = await probe
          .locator('[data-incremental-count]')
          .textContent()
          .catch(() => 'ABSENT');
        assert.fail(
          `Rebuilding the deferred boundary lost the interaction that triggered it: the count settled at ${JSON.stringify(found)}, expected ${JSON.stringify(expectedCount)}`,
        );
      });
    await probe.close();
  }

  enterStage('incremental-hydration');
  const incrementalBefore = await page.$('[data-incremental-boundary]');
  assert.notEqual(
    incrementalBefore,
    null,
    'Incremental SSR boundary is absent',
  );
  await page.locator('[data-incremental-action]').click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-incremental-count]')
        ?.textContent?.trim() === '1',
  );
  assert.equal(
    await incrementalBefore.evaluate(
      (element) =>
        element === document.querySelector('[data-incremental-boundary]'),
    ),
    true,
    'Incremental hydration replaced its transferred boundary',
  );

  enterStage('arabic-route-switch');
  await page.locator('[data-locale-choice="ar-EG"]').click();
  await page.waitForFunction(
    () =>
      document.documentElement.lang === 'ar-EG' &&
      document.documentElement.dir === 'rtl' &&
      document
        .querySelector('h1')
        ?.textContent?.includes('مختبر ميزات Atlas') &&
      document
        .querySelector('[data-incremental-message]')
        ?.textContent?.includes('حد الترجمة التدريجي جاهز.') &&
      document
        .querySelector('[data-dynamic-title]')
        ?.textContent?.includes('دليل أطلس للترجمة'),
  );
  await page.waitForURL(
    (url) =>
      url.pathname === '/ar-eg' &&
      url.searchParams.get('label') === 'hydration-request',
  );
  assert.equal(
    await page.locator('link[rel="canonical"]').getAttribute('href'),
    'https://atlas.example/ar-eg',
  );
  assert.match(
    await page.locator('[data-rich-message]').textContent(),
    /اقرأ الدليل/,
  );
  assert.equal(await page.locator('[data-inert-text] img').count(), 0);
  assert.match(
    await page.locator('[data-source-fallback]').textContent(),
    /Source fallback remains truthful/,
  );
  assert.equal(
    await page
      .locator('[data-dynamic-content]')
      .getAttribute('data-source-requests'),
    '1',
  );
  assert.equal(
    await page.locator('[data-comment-id="community-ar"]').getAttribute('lang'),
    'ar',
  );
  assert.equal(
    await page.locator('[data-comment-id="community-ar"]').getAttribute('dir'),
    'rtl',
  );
  assert.equal(
    await page
      .locator('[data-comment-id="community-multilingual"]')
      .getAttribute('data-representation'),
    'multilingual',
  );

  enterStage('english-route-switch');
  await page.locator('[data-locale-choice="en-US"]').click();
  await page.waitForFunction(
    () =>
      document.documentElement.lang === 'en-US' &&
      document.documentElement.dir === 'ltr' &&
      document
        .querySelector('h1')
        ?.textContent?.includes('Atlas feature lab') &&
      document
        .querySelector('[data-incremental-message]')
        ?.textContent?.includes('Incremental localization boundary ready.'),
  );
  await page.waitForURL(
    (url) =>
      url.pathname === '/en-us' &&
      url.searchParams.get('label') === 'hydration-request',
  );
  assert.equal(
    await page
      .locator('[data-dynamic-content]')
      .getAttribute('data-source-requests'),
    '2',
  );

  const initialUrl = page.url();
  assert.equal(
    await page.locator('[data-route-view="home"]').textContent(),
    'Home route',
  );
  enterStage('child-route-navigation');
  await page.locator('[data-route-link="second"]').click();
  await page.waitForURL((url) => url.pathname === '/en-us/second');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-route-view="second"]')
        ?.textContent?.trim() === 'Second route' &&
      document.querySelector('link[rel="canonical"]')?.getAttribute('href') ===
        'https://atlas.example/en-us/second',
  );
  assert.equal(
    await page.locator('[data-route-view="second"]').textContent(),
    'Second route',
  );
  assert.equal(
    await page.locator('link[rel="canonical"]').getAttribute('href'),
    'https://atlas.example/en-us/second',
  );
  const secondUrl = page.url();

  enterStage('history-back');
  await page.goBack();
  await page.waitForSelector('[data-route-view="home"]');
  assert.equal(page.url(), initialUrl);

  enterStage('history-forward');
  await page.goForward();
  await page.waitForSelector('[data-route-view="second"]');
  assert.equal(page.url(), secondUrl);

  enterStage('dynamic-article-route');
  await page.locator('[data-route-link="home"]').click();
  await page.waitForURL((url) => url.pathname === '/en-us');
  await page.locator('[data-route-link="article"]').click();
  await page.waitForURL(
    (url) => url.pathname === '/en-us/articles/atlas-handbook',
  );
  await page.waitForFunction(
    () =>
      document.title === 'The Atlas localization handbook' &&
      document
        .querySelector('[data-route-view="article"]')
        ?.getAttribute('data-entity-id') === 'atlas-handbook',
  );
  assert.equal(
    await page.locator('link[rel="canonical"]').getAttribute('href'),
    'https://atlas.example/en-us/articles/atlas-handbook',
  );
  assert.equal(
    await page
      .locator('link[rel="alternate"][hreflang="ar-EG"]')
      .getAttribute('href'),
    'https://atlas.example/ar-eg/articles/%D8%AF%D9%84%D9%8A%D9%84-%D8%A3%D8%B7%D9%84%D8%B3',
  );
  // The switcher's address and the alternate above are one derivation read twice, and each reader
  // forms its own string: the head states where the page lives, absolutely, on the origin this
  // application is deployed at; the option states where the reader is going, as a path on the host
  // they are actually on. This lab is served from localhost and declares `https://atlas.example`,
  // so an option carrying the head's string would take the reader off the machine they are on,
  // which is why they are asserted apart rather than compared to each other.
  //
  // The slug is the loaded one, so this also says the option waited for the declaration: before it
  // arrived there was no Arabic spelling to build an address from.
  const arabicAddress = await page
    .locator('[data-locale-choice="ar-EG"]')
    .getAttribute('href');
  assert.equal(
    arabicAddress,
    '/ar-eg/articles/%D8%AF%D9%84%D9%8A%D9%84-%D8%A3%D8%B7%D9%84%D8%B3',
  );

  enterStage('dynamic-article-locale-switch');
  await page.locator('[data-locale-choice="ar-EG"]').click();
  await page.waitForURL(
    (url) => decodeURIComponent(url.pathname) === '/ar-eg/articles/دليل-أطلس',
  );
  // The link said where the click would go, and it went there. A switcher whose href is derived
  // separately from the switch can disagree with it (on the query the reader is carrying, or on
  // the slug the page declared) and the reader finds that out by opening it in a new tab.
  assert.equal(new URL(page.url()).pathname, arabicAddress);
  await page.waitForFunction(
    () =>
      document.title === 'دليل أطلس للترجمة' &&
      document.documentElement.lang === 'ar-EG' &&
      document
        .querySelector('[data-dynamic-title]')
        ?.textContent?.includes('دليل أطلس للترجمة'),
  );
  assert.equal(
    await page.locator('link[rel="canonical"]').getAttribute('href'),
    'https://atlas.example/ar-eg/articles/%D8%AF%D9%84%D9%8A%D9%84-%D8%A3%D8%B7%D9%84%D8%B3',
  );

  await collectPolicyDiagnostics(page, chromiumDiagnostics);

  enterStage('chromium-focus-selection-composition-scroll');
  await page.goto(`${origin}/en-us?label=chromium-continuity`);
  await page.waitForFunction(
    () => document.documentElement.dataset['clientReady'] === 'true',
  );
  await exerciseLocaleContinuity(page);
  await assertDirectAccessibility(page);
  await collectPolicyDiagnostics(page, chromiumDiagnostics);

  enterStage('chromium-prerender-csr');
  await verifyRenderingModes(chromiumRow, context, chromiumDiagnostics);

  enterStage('chromium-switch-endurance');
  await verifySwitchEndurance(page, chromiumRow);
  await collectPolicyDiagnostics(page, chromiumDiagnostics);

  assertBrowserDiagnostics(chromiumDiagnostics, `Chromium ${chromiumVersion}`);
  Object.assign(chromiumEvidence, {
    outcome: 'verified',
    trustedTypes: chromiumTrustedTypes,
  });

  await context.close();
  context = undefined;
  await browser.close();
  browser = undefined;

  for (const row of browserRows.slice(1)) {
    enterStage(`${row.id}-browser-row`);
    browserRowEvidence(row).outcome = 'started';
    Object.assign(
      browserRowEvidence(row),
      await verifySecondaryBrowserRow(row),
      { outcome: 'verified' },
    );
  }
  // The last stage has no successor to report it, so it reports itself.
  leaveStage();
  clearTimeout(stageWatchdog);

  // Read on the green run rather than trusted on a red one. The success line below is built from
  // this array, so a row dropped from the loop would shorten the report and change nothing else:
  // the run would pass having verified two engines while claiming three.
  for (const evidence of browserEvidence) {
    assert.equal(
      evidence.outcome,
      'verified',
      `Browser assurance finished without verifying the ${evidence.label} row, which it reports on: ${JSON.stringify(browserEvidence)}`,
    );
  }

  process.stdout.write(
    [
      `${consumerProfile.label} (Angular ${consumerProfile.angular}, TypeScript ${consumerProfile.typescript}, RxJS ${consumerProfile.rxjs}): SSR isolation, rendering modes, accessibility, strict CSP, and live hydration verified.`,
      ...browserEvidence.map(
        (evidence) =>
          `${evidence.label} ${evidence.version}: Trusted Types ${evidence.trustedTypes ? 'enforced' : 'unsupported by engine; CSP directive retained'}.`,
      ),
    ].join('\n') + '\n',
  );
} catch (error) {
  verificationFailure = error;

  let pageState;
  try {
    pageState = await page?.evaluate(() => ({
      dataset: { ...document.documentElement.dataset },
      probe: document
        .querySelector('[data-ssr-probe]')
        ?.getAttributeNames()
        .reduce(
          (attributes, name) => ({
            ...attributes,
            [name]: document
              .querySelector('[data-ssr-probe]')
              ?.getAttribute(name),
          }),
          {},
        ),
    }));
  } catch (diagnosticError) {
    pageState = { diagnosticError: String(diagnosticError) };
  }

  verificationDiagnostics = {
    stage: verificationStage,
    stageElapsedMs: Date.now() - stageEnteredAt,
    browserEvidence,
    cspViolations,
    consoleErrors,
    pageErrors,
    requestFailures,
    pageState,
  };
} finally {
  releaseScriptRequests();
  await Promise.race([
    browser?.close() ?? Promise.resolve(),
    new Promise((resolveClose) => setTimeout(resolveClose, 5_000)),
  ]);
  await closeServer();
}

if (verificationFailure !== undefined) {
  const details = describeError(verificationFailure);
  process.stderr.write(
    `Atlas browser assurance failed.\n${details}\n${JSON.stringify(verificationDiagnostics, null, 2)}\n`,
  );
  process.exitCode = 1;
}
