# About diagnostics and runtime outcomes

Atlas reports two kinds of finding, from two places, with two audiences. The compiler's diagnostics
are about your sources. The runtime's outcomes are about what happened to one request.

## Codes

Every finding carries a code. The code is what you search for, what you suppress against, and what
you count, and it means the same thing across releases. The sentence beside it is for a person and
may be reworded; a build script that reacts to a class of finding matches on the code.

`packages/toolkit/DIAGNOSTICS.md` ships inside the toolkit package, so it is readable from an install
with no network. It is generated from the code union itself, which is why it cannot list a code Atlas
does not have or omit one it does. The same table is published as
[Diagnostics](../reference/diagnostics.md).

## Severity and exit codes

`atlas check` reports. `--require-complete` and `--require-fresh` turn classes of finding into
failures.

Exit codes are the half a build reads: `0` success, `1` diagnostics, `2` invocation or configuration,
`3` environment, `130` interruption. A build can tell a problem in your catalogs from a wrong
invocation, and act on the two differently.

## What a diagnostic contains

A code, a summary written for a person, and where in your sources it happened. It carries no visitor
text, no message content, no locale a person asked for that you do not serve, and no identifier
belonging to a person.

That is a property of the diagnostic rather than a setting. A log line carrying a visitor's input is
a record about that visitor and travels wherever the rest of the log travels, and a setting would
make that outcome depend on someone having chosen it.

## Runtime outcomes

A locale change succeeded, was redirected, or failed, and a failure carries a reason from a closed
set. `withObservability` sends those to a sink you supply. The sink receives an event rather than a
formatted line, so what you do with it is yours.

A value a formatter will not write is a runtime outcome too. Called through the facade it comes back
as a result with a diagnostic, which the caller reads. Used through a formatting pipe there is no
caller to read it, so a failed format renders an empty string and reports the diagnostic through the
same sink: nothing is silent and nothing throws in a template.

## Bounded cardinality

An event stream keyed on an unbounded value costs in proportion to traffic. A failure that repeats
once per render would emit one event per frame.

So the same failure inside a short window is one event, and every field an event carries is drawn
from a closed set rather than from a visitor's input. The cardinality of your metrics is a function of
your configuration rather than of your traffic.

## Telling the two apart

A code from the compiler names something in your sources and is fixed by editing them. A runtime
outcome names something that happened to one request and is usually about the network, the deployment,
or a locale you stopped shipping.

A visitor who saw the recovery message is a runtime outcome, and the message itself is
[About why the recovery message has no default](about-the-recovery-message.md).

## Related

- [How to set a recovery message](../how-to/set-a-recovery-message.md)
- [How to run generation in your build](../how-to/run-generation-in-your-build.md)
- [Diagnostics](../reference/diagnostics.md)
