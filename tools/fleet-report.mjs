#!/usr/bin/env node
// fleet-report — one-shot fleet health report for TrackForge (built by the 072 swarm).
const base = process.env.TRACKFORGE_URL || 'http://localhost:3000';
const tok = process.env.TRACKFORGE_TOKEN || '';
const h = { Authorization: 'Bearer ' + tok };
const get = async (p) => { const r = await fetch(base + p, { headers: h }); if (!r.ok) throw new Error(p + ' -> ' + r.status); return r.json(); };
const [health, metrics] = await Promise.all([get('/api/internal/fleet/health'), get('/api/internal/fleet/metrics')]);
console.log('status    : ' + health.status + ' (runner=' + health.runner.mode + ')');
console.log('outbox    : lastLag=' + health.outbox.lastDispatchLagMs + 'ms oldestPending=' + health.outbox.oldestUndispatchedAgeMs + 'ms undispatched=' + health.outbox.undispatched + ' deadLettered=' + health.outbox.deadLettered);
console.log('fleet     : open=' + metrics.fleet.openSessions + ' waitlist=' + metrics.fleet.waitlistDepth + ' locks=' + metrics.fleet.activeLocks + ' paused=' + metrics.fleet.paused);
