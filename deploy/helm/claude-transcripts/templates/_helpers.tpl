{{/*
GENERATED from the blueprint by scripts/gen-helm.ts — see deploy/helm/README.md.
*/}}

{{/* The env Secret every workload reads: the chart's, or one you manage (existingSecret). */}}
{{- define "claude-transcripts.envSecret" -}}
{{- .Values.existingSecret | default "claude-transcripts-env" -}}
{{- end }}

{{/*
Labels for this release, on object metadata only. Selectors keep the projection's
app.kubernetes.io/name + part-of, which are immutable once a Deployment exists.
*/}}
{{- define "claude-transcripts.releaseLabels" -}}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end }}
