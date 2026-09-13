# Releasing

This document describes how a release of `@neolorn/atlas` and `@neolorn/atlas-toolkit` is produced. The two packages share one version and are released together.

## Versioning

Versions follow [Semantic Versioning](https://semver.org). [Versioning and compatibility](docs/versioning.md) describes which surfaces the version number covers.

Prereleases use the form `0.0.0-rc.1` and are published under the `next` dist-tag. Stable releases are published under `latest`.

## Procedure

The commands below are written for version `0.0.0`, which this project cannot produce: versions only increase and the project is past it. Substitute the version being released. The example is deliberately impossible because a procedure written in a plausible next version reads as a record of that release rather than as an illustration of the steps.

1. **Write the changelog.** Add the release section to `CHANGELOG.md`: what was added, changed, fixed, and removed, any migration steps, and the supported host ranges. The changelog is written for someone deciding whether to upgrade. Its format is the one [Documentation](CONTRIBUTING.md#documentation) in the contributing guide states. At release the `[Unreleased]` section becomes that version's section, carrying its number and its date.

2. **Set the version.** Update `version` in `package.json`, `packages/runtime/package.json`, and `packages/toolkit/package.json`. The three must match; the verification suite fails otherwise.

3. **Commit and tag.** The tag is annotated, because step 5 pushes with `--follow-tags`, which
   carries annotated tags and silently leaves a lightweight one behind.

   ```sh
   git commit -am "chore(release): 0.0.0"
   git tag -a v0.0.0 -m "0.0.0"
   ```

4. **Run the verification suite** on the tagged commit:

   ```sh
   pnpm run verify
   ```

   The suite must pass in full. As part of the run, `verify:tarballs` packs both packages and verifies the archive contents against the build; the verified archives are written to `release/runtime/0.0.0/` and `release/toolkit/0.0.0/`, one directory per version so that a later release does not remove an archive this one has not published yet.

5. **Push the commit and the tag**, then read the tag back from the remote rather than trusting the push output:

   ```sh
   git push origin main --follow-tags
   git ls-remote --tags origin "v0.0.0*"
   ```

   Two lines must appear: `refs/tags/v0.0.0` and `refs/tags/v0.0.0^{}`. The second confirms the tag is annotated, and its object must equal what `git rev-parse v0.0.0^{}` prints locally, which is the release commit reaching the remote under the tag. One line means a lightweight tag arrived; no lines mean the tag was left behind. Neither is a release.

6. **Publish the verified archives.** Publish the archives the suite produced rather than repacking:

   ```sh
   npm publish release/runtime/0.0.0/neolorn-atlas-0.0.0.tgz
   npm publish release/toolkit/0.0.0/neolorn-atlas-toolkit-0.0.0.tgz
   ```

   For a prerelease, add `--tag next`. The registry is set by `publishConfig` in each manifest. Publish both packages in the same session.

7. **Create the GitHub release** from the tag, with the changelog section as its body.

8. **Verify the publication.** From a clean directory, install both packages at the new version and confirm they resolve.

## Withdrawing a release

A published version is never modified or republished. If a release must be withdrawn, deprecate it on the registry with a message pointing to the version that replaces it:

```sh
npm deprecate @neolorn/atlas@0.0.0 "Use 0.0.1"
npm deprecate @neolorn/atlas-toolkit@0.0.0 "Use 0.0.1"
```
