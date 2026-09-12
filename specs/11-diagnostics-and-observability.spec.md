# Diagnostics and observability

What Atlas says when something fails, what it says while it works, and what neither is allowed to
carry.

The severities and exit codes the command line applies to a diagnostic are
`10-compiler-and-tooling.spec.md` section 12. The ceilings on diagnostic count, summary length, and
path depth are `05-compiled-artifacts-and-trust.spec.md` section 7.

## 1. What a diagnostic is for

An Atlas release MUST report typed product-neutral diagnostics for authoring, compilation,
validation and admission, catalog loading, fallback and recovery, transitions, formatting, caching,
server rendering and hydration, and integrations. Product-neutral means the diagnostic names an
Atlas operation and never a consumer application's vocabulary, so the same code means the same thing
in every project that receives it.

Fallback and recovery stay diagnosable. An Atlas release MUST NOT let a diagnostic turn a systemic
failure into a silent success: rendering a source-locale message where a translation is missing is
correct behavior and a reported one, and a catalog that failed to load is not the same event as a
message that was never translated.

## 2. The toolkit diagnostic

A toolkit diagnostic carries a code, a severity, a one-sentence summary, the path into the document
it concerns, and, where it has one, an exact source span. An Atlas release MUST NOT make a
diagnostic's meaning depend on its wording, because the wording is not a compatibility surface and
the code is.

An Atlas release MUST bound the summary, the path, and the number of diagnostics one operation
produces, and MUST refuse or replace a control character, a directional override, or an isolate
inside diagnostic text, because a diagnostic is printed to a terminal and read by a machine and
neither should be steerable by the input that produced it.

An Atlas release MUST report both the value it received and the position it received it in, so a
diagnostic is actionable without a second run to locate it, and MUST NOT report the value where
doing so would breach section 5.

## 3. The runtime diagnostic

A runtime diagnostic carries a code naming the operation that failed, an outcome class naming what
kind of thing happened, a message, and the bounded identities that locate it: the target and
supplying locale, the provider, the scope, the participant, the transition, and the message
identity. Both the code and the outcome class come from closed sets.

The outcome class is what a consumer application branches on, and an Atlas release MUST keep its
three cases apart. An operational failure is Atlas's or the platform's and is the application's to
retry, report, or escalate. A representation-unavailable outcome means the content exists in no
approved representation, which is a fact about the content rather than a defect. A domain outcome is
the application's own answer, valid and complete, arriving through a localization contract.

An Atlas release MUST attach a caught underlying error to the raised error's cause rather than
copying it into the diagnostic, so a stack trace, a filesystem path, and whatever a consumer
application's own code threw reach a developer without passing through a contract that must stay
free of them.

## 4. Codes and stability

The codes and the documented machine fields are compatibility surfaces. An Atlas release MUST NOT
reassign a code, and MUST NOT treat human wording, a sampling hint, or an undocumented debug detail
as one, because a consumer application that keys an alert on a code should not have to re-read a
sentence after an upgrade.

Every code is documented. An Atlas release MUST derive that reference from the declaration of the
codes themselves rather than maintaining a second list, because a hand-kept list is a second source
that drifts on the first commit that adds a code, and the entry nobody remembers to write is the one
nothing reports.

## 5. What a diagnostic may not carry

An Atlas release MUST exclude from a diagnostic and from an event: translated text and source or
catalog bodies; message parameters and rich-slot payloads; user content; credentials, tokens,
cookies, private headers, and other secrets; machine-absolute paths and user or host identity; and
unsafe untrusted input text.

An Atlas release MUST NOT let an ordinary verbosity setting enable content capture, because a flag
that turns logging up is set by people who are debugging and read by systems that retain what they
are given.

The exclusion is structural rather than a rule applied at each site. An Atlas release MUST make the
reason a diagnostic carries a closed set rather than free text, so that whatever was caught, nothing
of it can be copied into the diagnostic; and MUST truncate an identifier that reaches a diagnostic
to a bounded length and replace any control character in it, so an identity a consumer application
supplied cannot rewrite the line it appears in.

## 6. Observability sinks

An Atlas release MAY expose narrow optional sinks for logs, metrics, traces, development inspection,
and tests. An Atlas release MUST NOT contain a telemetry transport, an account, an endpoint, a
background upload, an analytics collector, or a vendor library, so adopting Atlas adds no service
to a deployment diagram.

With no sink configured, an Atlas release MUST perform no observability work at all: no network
request, no persistent storage, and no event construction, so an application that wants none pays
nothing for the capability.

A consumer application owns collection, retention, sampling, dashboards, alerts, incident response,
and transport. Product analytics and business events stay outside Atlas, and an Atlas release MUST
NOT emit one.

## 7. The event

An event carries a profile marker, a code, a lifecycle phase, a status, and, where they apply, the
reason, the bounded provider, scope, participant, locale, correlation, transition, and snapshot
identities, and bounded counts and durations. An Atlas release MUST NOT put anything else in one.

The status set says what actually happened rather than only whether it worked. An Atlas release MUST
report work that was cancelled, superseded, or unavailable as itself rather than as a failure, and
MUST report work that belonged elsewhere as redirected: a locale change under a locale-specific
origin policy is a document navigation, so reporting success would claim a transition that never
ran, and reporting failure would claim a defect where the outcome was correct.

The toolkit and the runtime emit their own event shapes under their own profile markers, because a
compilation phase and a transition phase are different vocabularies and one union of both would name
neither well.

## 8. Containment and bounded cardinality

Sink execution is isolated and failure-contained. An Atlas release MUST NOT let a sink change locale
resolution, catalog loading or admission, formatting, a commit, a security decision, fallback, or
the request lifecycle, and MUST NOT let a sink that throws escape into a server render or leave
localization state changed.

An Atlas release MUST bound every field before it emits: an identifier beyond its length bound or
carrying a control character is dropped rather than truncated into something that looks like an
identity, and a count or a duration outside its range is dropped rather than emitted as a number
nothing measured.

An Atlas release MUST deduplicate equivalent repeated failures within a bounded window and MUST
bound the set of failure identities it remembers, discarding the oldest first, so a broken catalog,
a retry loop, a missing message, or a slow sink cannot produce unbounded memory or an event storm.
The identity of a repeat is the code, the phase, the status, the reason, and the provider, scope, and
locale it concerns, because two failures that agree on all of those are one failure being reported
again.
