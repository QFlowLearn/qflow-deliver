# Harbor Load Drills

Phase 4 load tooling is written for deployed Harbor staging, not the local Miniflare harness. Use a real Cloudflare worker URL for `BASE_URL` or `STAGING_URL` so launch, bootstrap, queue, and telemetry paths exercise the same edge runtime that rollout gates depend on.

## Seed A Staging Fixture

The staging helper republishes the existing `tests/fixtures/qti/basic-assessment` package through Harbor's `/internal/publish` route and prints only the resulting `assessmentVersionId` to stdout. That keeps it shell-friendly for `k6` commands:

```bash
ASSESSMENT_VERSION_ID=$(node tools/load/seed-phase4-fixture.mjs --base-url "$STAGING_URL" --seed phase4-launch)
```

Supported flags:

- `--base-url`: deployed Harbor runtime origin. Falls back to `STAGING_URL` or `BASE_URL`.
- `--seed`: assessment slug suffix used for both the publish slug and default tenant ID.
- `--fixture`: fixture directory name under `tests/fixtures/qti/`. Defaults to `basic-assessment`.
- `--tenant-id`: optional explicit tenant override.
- `--package-name`: optional package filename sent to `/internal/publish`.

## Launch Drill

`tools/load/launch-surge.js` models synchronized exam starts with an open-model arrival-rate scenario. Each iteration:

1. creates a preview attempt with `POST /api/launch/preview`
2. exchanges the bootstrap token with `POST /api/bootstrap`
3. fetches `GET /api/content/manifest`
4. fetches the current item with `GET /api/content/items/:itemId`

The drill intentionally exercises Harbor's incremental manifest and item startup path instead of downloading a package ZIP.

Example:

```bash
k6 run tools/load/launch-surge.js \
  -e BASE_URL="$STAGING_URL" \
  -e ASSESSMENT_VERSION_ID="$ASSESSMENT_VERSION_ID" \
  -e RATE=20 \
  -e DURATION=20s
```

Environment contract:

- `BASE_URL`: required deployed Harbor runtime origin.
- `ASSESSMENT_VERSION_ID`: required output from `seed-phase4-fixture.mjs`.
- `RATE`: arrivals per second. Default `20`.
- `DURATION`: scenario duration. Default `30s`.
- `PRE_ALLOCATED_VUS`: initial VU pool. Default `25`.
- `MAX_VUS`: surge ceiling if the edge slows down. Default `200`.
- `MAX_FAILURE_RATE`: threshold applied to launch, bootstrap, manifest, and item requests. Default `0.01`.
- `LAUNCH_P95_MS`, `LAUNCH_P99_MS`: launch preview latency thresholds. Defaults `1000` / `1500`.
- `BOOTSTRAP_P95_MS`, `BOOTSTRAP_P99_MS`: bootstrap latency thresholds. Defaults `1000` / `1500`.
- `MANIFEST_P95_MS`, `MANIFEST_P99_MS`: manifest latency thresholds. Defaults `750` / `1200`.
- `ITEM_P95_MS`, `ITEM_P99_MS`: item latency thresholds. Defaults `750` / `1200`.

The script tags each step separately so `http_req_failed` and `http_req_duration` thresholds track launch, bootstrap, manifest, and item reads independently.
