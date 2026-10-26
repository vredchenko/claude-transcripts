# The omnibus as one BuildKit graph: the app image, the Fossil image and the omnibus
# itself, built together so the components build in parallel and share one layer cache.
#
#   docker buildx bake -f deploy/omnibus/docker-bake.hcl --load omnibus   # what omnibus:build runs
#   APP_IMAGE=ghcr.io/OWNER/claude-transcripts-app:v1.2.3 docker buildx bake ...
#
# The omnibus Dockerfile takes its components as APP_IMAGE / FOSSIL_IMAGE. Here they
# name build contexts rather than registry images: "app-src" is the root Dockerfile's
# build, "fossil-src" deploy/fossil's. Set APP_IMAGE to assemble from a published app
# image instead of building one (the release does: it reuses the image it just scanned
# and pushed).

variable "CT_VERSION" {
  default = "0.0.0-dev"
}

variable "APP_IMAGE" {
  default = ""
}

variable "OMNIBUS_TAG" {
  default = "claude-transcripts-omnibus:local"
}

# "gha" in CI: each target keeps its layers in the GitHub Actions cache (mode=max, so
# intermediate stages too — the dependency install, the CLI cross-compiles, the UI
# builds). Needs a docker-container builder; CI gets one from setup-buildx-action.
variable "CACHE" {
  default = ""
}

function "cache_from" {
  params = [scope]
  result = CACHE == "gha" ? ["type=gha,scope=omnibus-${scope}"] : []
}

function "cache_to" {
  params = [scope]
  result = CACHE == "gha" ? ["type=gha,mode=max,scope=omnibus-${scope}"] : []
}

target "app" {
  context    = "."
  dockerfile = "Dockerfile"
  args       = { CT_VERSION = CT_VERSION }
  cache-from = cache_from("app")
  cache-to   = cache_to("app")
}

target "fossil" {
  context    = "deploy/fossil"
  cache-from = cache_from("fossil")
  cache-to   = cache_to("fossil")
}

target "omnibus" {
  context    = "."
  dockerfile = "deploy/omnibus/Dockerfile"
  args = {
    APP_IMAGE    = "app-src"
    FOSSIL_IMAGE = "fossil-src"
  }
  contexts = {
    app-src    = APP_IMAGE == "" ? "target:app" : "docker-image://${APP_IMAGE}"
    fossil-src = "target:fossil"
  }
  tags       = [OMNIBUS_TAG]
  cache-from = cache_from("omnibus")
  cache-to   = cache_to("omnibus")
}
