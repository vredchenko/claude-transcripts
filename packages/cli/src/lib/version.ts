/**
 * The CLI's own version. Baked in at build time (`--define process.env.CT_VERSION` in
 * the Dockerfile and release-cli.yml); a checkout running from source is "0.0.0-dev",
 * which `install` reads as "track the `main` image" rather than pinning a release.
 */
export const DEV_VERSION = "0.0.0-dev";
export const VERSION: string = process.env.CT_VERSION ?? DEV_VERSION;
export const isRelease = (): boolean => VERSION !== DEV_VERSION;
