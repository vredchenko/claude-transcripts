# The scan tools, pinned by version and digest. Never built: action.yml and
# lockfile-scan.yml read the FROM lines and run each image as is. A Dockerfile so
# that Dependabot's docker ecosystem keeps the pins current (#302).
FROM ghcr.io/anchore/grype:v0.122.1@sha256:661583704a253c0448ed63998b5ea2cd9d5a76ee71eedc4aed439b8ce3e93a1c AS grype
FROM ghcr.io/aquasecurity/trivy:0.76.2@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb AS trivy
# Not an image scanner: lockfile-scan.yml runs it over bun.lock. Pinned here so the same
# Dependabot entry keeps it current.
FROM ghcr.io/google/osv-scanner:v2.7.1@sha256:a70ffffc2bfd33482953e5d6b64c6fcdb30239717a07b0f0d3ab2859ce3e4cde AS osv-scanner
