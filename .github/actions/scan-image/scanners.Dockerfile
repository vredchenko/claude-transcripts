# The scan gate's tools, pinned by version and digest. Never built: action.yml reads
# the two FROM lines and runs each image as is. A Dockerfile so that Dependabot's
# docker ecosystem keeps the pins current (#302).
FROM ghcr.io/anchore/grype:v0.122.1@sha256:661583704a253c0448ed63998b5ea2cd9d5a76ee71eedc4aed439b8ce3e93a1c AS grype
FROM ghcr.io/aquasecurity/trivy:0.76.2@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb AS trivy
