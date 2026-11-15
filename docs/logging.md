# Logging

All app logs are pino JSON on stdout (016) — one line per request/job with
`requestId`, `traceId`, `actorId`, `path`, `status`, `ms`. No secrets are
logged by construction (the logger only emits the fields above).

## Levels

`LOG_LEVEL=debug|info|warn|error` (default `info`). `debug` adds query
traces; keep it off in steady-state prod.

## Shipping

stdout is the contract — collect however your platform collects container
logs:

```yaml
# journald driver example
services:
  app:
    logging:
      driver: journald
      options:
        tag: trackforge
```

For Loki, point promtail/docker-driver at the `trackforge` container and
parse JSON fields — `requestId`/`traceId` correlate requests to job runs.

## Retention

Container logs rotate via your log driver; no in-app file logs exist.
Domain events (audit) have their own DB retention: `EVENT_RETENTION_DAYS`
(default 90).
