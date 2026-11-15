# Alerting

Alerts live in `deploy/monitoring/alerts.yml` (loaded by the monitoring
compose profile). Each rule names its runbook section.

| Alert | Condition | What to do |
|---|---|---|
| `TrackForgeHighErrorRate` | 5xx > 5% of requests for 5m | runbook → site down |
| `TrackForgeQueueBacklog` | waiting jobs > 100 for 10m | runbook → webhooks not firing |
| `TrackForgeQueueFailures` | failed jobs > 10 | runbook → webhooks not firing |
| `TrackForgeBackupStale` | no successful backup in 26h | runbook → backups |
| `TrackForgeOutboxLag` | undispatched events > 500 | runbook → emails not sending |
| `TrackForgeSlowRequests` | p95 latency > 1s for 15m | runbook → slow JQL |

Alertmanager is deliberately not wired — route alerts via Grafana
notification policies or your own Alertmanager in the profile.
