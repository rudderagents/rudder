# Daemon-local test fixtures

Copies of data that used to be read from sibling monorepo trees (`ios/`, `push-gateway/`, `site/`). The public `rudderagents/rudder` repo is daemon-only, so these files travel with the suite.

- `live-activity-alerts.json` — the push-gateway `LIVE_ACTIVITY_ALERTS` allowlist (r59 F-10).
- `app-catalog-alerts.json` — translations for the live-activity / live-card keys, taken from the app string catalog.
- `windows-latest.json` — the site's Windows update placeholder (`{"version":null}`).

When the sibling tree is present, a parity test checks the fixture still matches it.
