# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |

Fixes are released on the current minor version. Older versions do not receive security fixes.

## Reporting a vulnerability

Report vulnerabilities privately, by either route:

- Email [security@neolorn.com](mailto:security@neolorn.com).
- Use [GitHub's private vulnerability reporting](https://github.com/neolorn/atlas/security/advisories/new).

Do not open a public issue, discussion, or pull request for a vulnerability.

Include:

- a description of the issue and its impact;
- the versions of `@neolorn/atlas` and `@neolorn/atlas-toolkit` affected;
- steps to reproduce, with the catalog, configuration, or route involved where relevant;
- whether the issue affects the browser runtime, server rendering, or the toolkit at build time.

You will receive an acknowledgement, and you will be kept informed while the report is assessed and fixed. Reporters are credited in the release that contains the fix unless they ask not to be.

## Scope

Atlas treats translated content as untrusted data. The following are security issues:

- catalog content that executes code, imports modules, compiles a template, or otherwise gains the privileges of Atlas code;
- markup or script reaching the page through a message, a slot, or a formatted value;
- a bidirectional or Unicode sequence that changes how rendered text reads;
- a compiled artifact that passes an identity, compatibility, integrity, or resource check it should fail, or a check that can be bypassed;
- a resource limit that can be exceeded so that a catalog or a message exhausts memory or time;
- the toolkit reading or writing files outside the paths it owns;
- a locale, URL, or negotiation input that bypasses validation;
- a diagnostic, log, or observability event that includes content it should not.

The following are out of scope:

- defects without a security consequence, which are ordinary [bug reports](https://github.com/neolorn/atlas/issues/new/choose);
- vulnerabilities in Angular, Node.js, or other dependencies, unless Atlas is what exposes them; report those to the project that owns them;
- versions outside the [supported ranges](docs/reference/compatibility.md).

## Disclosure

A fix is released before the vulnerability is described publicly. The release notes state what the vulnerability allowed, which versions are affected, and what upgrading requires.
