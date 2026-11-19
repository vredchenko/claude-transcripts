/**
 * The app's version: the one committed source of truth (#289).
 *
 * Every component manifest carries the same lockstep version (ADR 0023), stamped by
 * `scripts/release.ts` in the same commit that is tagged. This reads it from this
 * package's own `package.json`, so the webapi, the CLI (bundled into the compiled
 * binary), the webui and the blueprint all report the same value, with no build-time
 * input that can be dropped on the way — which is how the omnibus came to report
 * a dev placeholder while shipping 0.10.2.
 *
 * Spelled as the git tag is, `v` and all: `--version`, `GET /health`, the statusline
 * and the app image tag `install` pins all use `vX.Y.Z`. The prefix is added here and
 * nowhere else.
 *
 * There are no dev builds: a checkout of `main` reports the version of the tree it was
 * built from, and only a release tag publishes anything.
 */
import pkg from "../package.json" with { type: "json" };

/** Bare semver, as the manifests hold it: `0.10.2`. */
export const APP_SEMVER: string = pkg.version;

/** The tag spelling every surface reports: `v0.10.2`. */
export const APP_VERSION = `v${APP_SEMVER}`;
