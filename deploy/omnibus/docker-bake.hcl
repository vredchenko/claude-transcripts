# The omnibus as one BuildKit graph: the app image, the Fossil image, the rebuilt Garage
# web UI and the omnibus itself, built together so the components build in parallel and share one layer cache.
#
#   docker buildx bake -f deploy/omnibus/docker-bake.hcl --load omnibus   # what omnibus:build runs
#   APP_IMAGE=ghcr.io/OWNER/claude-transcripts-app:v1.2.3 docker buildx bake ...
#
# The omnibus Dockerfile takes its components as APP_IMAGE / FOSSIL_IMAGE /
# GARAGE_UI_IMAGE. Here they name build contexts rather than registry images: "app-src"
# is the root Dockerfile's build, "fossil-src" deploy/fossil's, "garage-ui-src"
# deploy/garage-ui's. Set APP_IMAGE to assemble from a published app
# image instead of building one (the release does: it reuses the image it just scanned
# and pushed).

variable "CT_VERSION" {
  default = "0.0.0-dev"
}

variable "APP_IMAGE" {
  default = ""
}

# The fetch-only source clone inside the image (see the Dockerfile). A release sets
# both to its own repository and tag.
variable "OMNIBUS_GIT_URL" {
  default = "https://github.com/vredchenko/claude-transcripts.git"
}

variable "OMNIBUS_GIT_REF" {
  default = "main"
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

target "garage-ui" {
  context    = "deploy/garage-ui"
  cache-from = cache_from("garage-ui")
  cache-to   = cache_to("garage-ui")
}

target "omnibus" {
  context    = "."
  dockerfile = "deploy/omnibus/Dockerfile"
  args = {
    APP_IMAGE       = "app-src"
    FOSSIL_IMAGE    = "fossil-src"
    GARAGE_UI_IMAGE = "garage-ui-src"
    OMNIBUS_GIT_URL = OMNIBUS_GIT_URL
    OMNIBUS_GIT_REF = OMNIBUS_GIT_REF
  }
  contexts = {
    app-src       = APP_IMAGE == "" ? "target:app" : "docker-image://${APP_IMAGE}"
    fossil-src    = "target:fossil"
    garage-ui-src = "target:garage-ui"
  }
  tags       = [OMNIBUS_TAG]
  cache-from = cache_from("omnibus")
  cache-to   = cache_to("omnibus")
  # The runtime stage runs `apt-get upgrade`. A cached copy of that layer keeps the OS
  # packages of whenever it was first built, so a fix Debian has since shipped never
  # lands and the scan gate fails on it. The stage is that one step plus COPYs from the
  # other stages, so always rebuilding it costs little; everything before it still caches.
  no-cache-filter = ["runtime"]
}
