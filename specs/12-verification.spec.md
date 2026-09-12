# Verification

What an Atlas release proves about itself before it ships, and what it declines to claim.

The host rows a release executes and the proof taken through its built packages are
`02-packages-and-platform.spec.md` sections 9 and 11. What a check is allowed to report is
`11-diagnostics-and-observability.spec.md`.

## 1. What verification proves

An Atlas release MUST verify every capability it ships, in proportion to its correctness, security,
compatibility, accessibility, performance, and regression risk. An Atlas release MUST NOT substitute
a certificate, an evidence ledger, a named owner, or a test count for evidence that the behavior
holds, because none of those changes when the behavior does.

An Atlas release MUST exercise a shipped capability whether or not any consumer application
currently enables it. A capability whose only evidence is that somebody uses it stops being verified
on the day they stop.

## 2. Where the evidence comes from

An Atlas release MUST own the fixtures that prove its behavior, and MUST NOT treat a consumer
application's own testing as closing a row of that evidence. A consumer application corroborates the
paths it genuinely enables, on the stack it genuinely runs, and an Atlas release MUST NOT read that
corroboration as wider than the stack it was taken on.

An Atlas release MUST keep fixtures that select the minimum rather than proving everything through
one application that selects everything, because tree shaking, entry-point isolation, deep-import
refusal, and toolkit code staying out of a browser graph are all claims about what is absent, and an
application holding every capability cannot demonstrate an absence.

## 3. Coverage, and the checks a release does not run

An Atlas release MUST name the checks it deliberately does not run. A coverage list that stays
silent about them reads as a claim that they exist.

An Atlas release MAY verify direction, document language, isolation, and its live region as
attributes and computed styles rather than by comparing images, because those are the properties
Atlas owns and an image comparison also fails on a consumer application's unrelated redesign.

An Atlas release SHOULD verify its parsers, canonicalizers, and formatters with generated valid
input checked against a property rather than with random bytes. Random bytes are refused at a
parser's front door, which is already the best covered path, and never reach the transforms behind
it, which is where a destructive defect survives. An Atlas release MUST seed a generator from a
constant it carries, so a failure is reproducible rather than merely reported.

## 4. Negative verification

An Atlas release MUST verify refusal as thoroughly as acceptance, and MUST cover at least:

- invalid, duplicate, and malformed catalogs, and unknown functions, slots, inputs, and identities;
- an artifact refused for identity, compatibility, integrity, provenance, or a resource limit;
- a failed load, a cancellation, a coalesced or superseded transition, and racing transitions;
- a participant that is pending, that fails, that has no representation, and that answers with a
  valid domain outcome;
- consumer content reaching a catalog, a cache, a snapshot, transfer state, a diagnostic, or an
  event;
- request isolation, cleanup, hydration mismatch, and transfer reuse;
- a missing translation under every fallback and recovery setting;
- unsafe rich content, unsafe URLs, authored bidirectional controls, and XML, YAML, and JSON
  attacks;
- exhaustion of decompression, parsing, analysis, evaluation, caching, and diagnostics.

An Atlas release MUST verify a validator against values that are not text at all, because a
parameter declared as text stops nothing at a boundary where the type is not present.

## 5. Representative locales

An Atlas release MUST verify its mechanisms against locales that differ in the ways those mechanisms
depend on, covering at least a right to left language, plural categories beyond one and other,
non-Latin digits, a script written without spaces, complex shaping, a supplying language different
from the target, content whose language is unknown or deliberately fixed, and a pseudo-locale.

An Atlas release MUST take a locale's categories, endonyms, and formats from the locale data it
pins rather than from the host, so an answer does not change with whichever runtime a build happens
to use. A fixture matrix verifies mechanisms, and an Atlas release MUST NOT turn one into a
production locale default.

## 6. Conformance suites and pinned data

Where a standard the profile pins publishes a conformance suite, an Atlas release MUST run that
suite for the edition it declares, pinned by digest, and through its built packages. A suite from
another revision tests another specification and reports the difference as a defect.

An Atlas release MUST record which stage answers a case rather than reshaping the case to reach a
particular one. A compiled system refuses at compile time much of what an interpreting
implementation refuses at evaluation time, and that is the correct behavior rather than a deviation
to be hidden.

## 7. A promise nothing exercises

Where an Atlas release promises something statically, a fixture MUST fail when the promise is
withdrawn. A type nothing instantiates, a guard nothing crosses, and an export nothing reaches are
promises no reader has tested, and each of them compiles.

An Atlas release MUST verify a resolved instance rather than a provider declaration wherever a
consumer application is asked to replace or subclass an injectable, because a subclass inherits its
base's provider and resolving it can silently construct the very implementation the subclass was
written to replace.

An Atlas release MUST NOT hold an export used on evidence that disappears, such as a scratch file or
a throwaway script, and MUST NOT answer the question with a count, because a count is a ceiling that
new unreachable surface fits under.

## 8. Property and differential verification

An Atlas release MUST check its formatting and parsing against an authority it did not write. A
formatter that emits the wrong digits, drops a group separator, or swaps the decimal and group
separators round-trips perfectly against its own parser and fails every reader.

An Atlas release MUST give a repaired defect the smallest durable test at the layer that owns it,
and SHOULD prefer a property over a single case wherever the defect has a shape that other inputs
share. An Atlas release MUST NOT rest a claim on a broad snapshot, on a duplicate of framework
behavior, or on an assertion about an implementation detail.

## 9. Proving a check can fail

An Atlas release MUST prove that its checks can fail, by withdrawing the behavior a check guards and
requiring that check to notice. A check nobody has seen fail is indistinguishable from a check that
cannot, and no passing run tells the two apart.

An Atlas release MUST NOT derive a check from the thing it checks. Expected values computed through
the functions under test, a graph transcribed from the order it is meant to verify, and an
observation generated from the declaration it is meant to test all agree by construction, and
agreeing is not the same as being right.

An Atlas release MUST treat an absent observation as absent rather than as agreement, so a failure
of the observing mechanism cannot present itself as a clean result.

Where a check compares against a recorded baseline, an Atlas release MUST make recording that
baseline a separate deliberate act, and MUST NOT let a failing run rewrite the baseline it is
failing against. A baseline something can move on your behalf has only ever been moved in the
direction that passes.

## 10. Cost and resource measurement

An Atlas release MUST publish reproducible measurements for its runtime, its framework integration,
its generated contracts, its compiler work, and its packages, and MUST measure each published entry
point separately.

An Atlas release MUST assert the shape of a cost rather than an absolute duration wherever the
measurement runs on a machine it does not control. Complexity transfers across machines and
milliseconds do not: an absolute limit measures the runner, is flaky while it is strict, and once
padded enough to stop being flaky can no longer fail.

An Atlas release MUST vary what the cost depends on: message, scope, provider, and locale counts;
message complexity; cold and warm generation; initial and lazy catalog loading; coordinated and
progressive locale switching; participant count and readiness; server rendering concurrency and
hydration transfer; cache pressure; repeated failure; and adversarial input at and beyond the
allowed bounds.

## 11. Thresholds and ceilings

An Atlas release MUST impose a hard ceiling only where a safe algorithm or resistance to a denial of
service requires one. Defaults SHOULD be generous, automatic, and configurable by a consumer
application within ceilings the release does not allow to be bypassed.

An Atlas release MUST establish a numeric threshold by measurement and record it in the document
that owns it, and MUST NOT present a guessed number as a timeless one. Where the property under
test is a cost, an Atlas release MUST verify it by a count the machine cannot change, and MUST NOT
keep a recorded timing figure as the threshold a later run is compared against. A cache is verified
by counting what it constructs, and a growth curve by the shape its own measurements take.

A test timeout is a hang detector. An Atlas release MUST size one so that reaching it means the test
was never going to finish, and MUST NOT use one as a performance budget.

## 12. What stays with the consumer

A consumer application owns its own continuous integration, approvals, staffing, evidence retention,
release workflow, bundle budgets, traffic objectives, infrastructure capacity, and product
performance targets. An Atlas release MUST NOT require a consumer application to adopt a capability,
invent a feature, or run a check merely to widen Atlas's own evidence.

An Atlas release MUST supply the commands, fixtures, and testing surface a consumer application
needs to verify its own use of Atlas, and MUST NOT attempt to size a consumer application's host.
How much concurrency one host sustains depends on its cores, its memory, and what else runs on it,
which is capacity planning rather than a property of Atlas.
