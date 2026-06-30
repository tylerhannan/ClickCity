# ClickCity

An isometric voxel **schema visualizer for ClickHouse**. Point it at a ClickHouse
HTTP endpoint and it renders your databases as a little pixel-art city: every table
is a block, block height is the log-scaled on-disk size, block color is the table
engine, dependency edges (materialized-view chains, `Distributed` tables) are
drawn as isometric connectors, and building lights show recent read/write workload.
Click a block to inspect the table.

Pure frontend — no backend. The browser queries `system.tables` and `system.parts`
directly over the ClickHouse HTTP interface. Deploys as a static site to GitHub Pages.

![mock city](docs/screenshot.png)

## Stack

- **Vite** + **React** + **TypeScript**
- Plain `<canvas>` 2D for the isometric rendering — no graph/3D libraries

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
```

You don't need a running ClickHouse to work on the visuals: on the connection
screen click **Explore with mock data** (`src/data/mockData.ts`).

## What the visualization means

ClickCity is a map of ClickHouse schema shape and recent workload:

- **One building = one table-like object** from `system.tables`, including tables,
  views, materialized views, dictionaries, and distributed tables.
- **Neighborhoods = databases.** Tables are grouped by database, and each database
  gets a subtle tint so separate schemas read as separate districts.
- **Building height = table footprint.** Height uses a log scale from
  `system.parts.bytes_on_disk`; if parts are unavailable, ClickCity falls back to
  `system.tables.total_bytes` / `total_rows`.
- **Building top color = engine family.** MergeTree, Materialized View, Dictionary,
  Distributed, View, and Other each get their own color bucket.
- **Connector lines = dependencies.** These come from
  `system.tables.dependencies_database` and `dependencies_table`; they make
  materialized-view chains and distributed-table relationships visible.
- **Cyan windows = rows read recently.** Read heat comes from
  `system.query_log.rows_read`, normalized on a log scale against the busiest table.
- **Magenta windows = rows written recently.** Write heat comes from
  `system.query_log.written_rows`, also log-normalized.
- **Window brightness/density = workload intensity.** Query count from
  `system.query_log` boosts brightness, while rows read/written control how many
  windows light up on each face.
- **Pulse/halo = combined recent activity.** The glow combines query count,
  throughput, and peak memory from `system.query_log`. If query-log access is
  denied or disabled, workload lights stay mostly dark rather than inventing data.
- **Red roof beacon = very large table.** Tall buildings get a small beacon so the
  biggest storage objects remain easy to spot.

### Mock data example

The built-in mock city is designed to exercise those meanings:

- `analytics.events` is one of the tallest buildings and should show strong cyan
  read heat because the mock workload reads 18.4B rows recently.
- `staging.raw_events` is also tall, but its magenta write lights dominate because
  the mock workload writes 7.9B rows recently.
- `analytics.daily_rollup_mv`, `staging.raw_events_mv`, and `shop.revenue_mv` are
  Materialized View buildings with connector lines to the tables they depend on.
- `analytics.events_dist` is a short Distributed building connected back to
  `analytics.events`, showing that it is important in query flow even though it
  does not own much storage.
- Smaller dimension-style objects like `analytics.geo_dict` stay shorter and
  dimmer unless their mock activity is high.

## Connecting to ClickHouse

On the connection screen enter the HTTP endpoint, user, and password:

- **Play demo (recommended first run):** `https://play.clickhouse.com` (preset in UI)
- **Local / self-hosted:** `http://localhost:8123`
- **ClickHouse Cloud:** `https://<host>.clickhouse.cloud:8443`

Because the queries run from the browser, the ClickHouse server must allow the
page's origin via **CORS**. ClickCity already appends `add_http_cors_header=1` to
each request, which makes self-hosted servers emit `Access-Control-Allow-Origin: *`.
For ClickHouse Cloud, add the site's origin to the service's allowed CORS origins.

### The schema and workload queries

`src/clickhouse/client.ts`:

1. **Tables** — metadata from `system.tables` (database, name, engine, and the
   `dependencies_database` / `dependencies_table` arrays used to draw edges).
2. **Parts** — `sum(bytes_on_disk)` and `sum(rows)` over active parts in
   `system.parts`, grouped by `(database, table)`, used for block height.
3. **Table totals fallback** — `system.tables.total_rows` and `total_bytes`, used
   when `system.parts` is restricted or sparse.
4. **Recent activity** — optional aggregates from `system.query_log` over the last
   30 minutes, used for cyan read windows, magenta write windows, and pulse glow.

Columns shown in the detail panel are fetched lazily from `system.columns` when a
block is selected.

## Deploy to GitHub Pages

### Automatic deploy on push (recommended)

This repo includes `.github/workflows/pages.yml`, which builds and deploys to
GitHub Pages on every push to `main`.

In repository settings:

1. Open **Settings → Pages**
2. Set **Source** to **GitHub Actions**
3. Push `main`

The workflow computes `VITE_BASE` from the repo name, so project-page asset
paths stay correct after a rename.

### Manual deploy to `gh-pages` branch

```bash
npm run deploy        # builds and pushes dist/ to the gh-pages branch
```

Then in the repository settings set **Pages → Source → `gh-pages` branch**. The
site will be served from `https://<user>.github.io/ClickCity/`.

The Vite `base` is set to `/ClickCity/` in `vite.config.ts`. If you rename the repo,
either change `base` or build with `VITE_BASE=/<new-name>/ npm run build`.

## Project layout

```text
src/
  clickhouse/client.ts   HTTP interface + the two schema queries
  data/mockData.ts       hardcoded schema for offline visual development
  iso/iso.ts             isometric projection, layout, drawing, hit-testing
  components/
    ConnectionScreen.tsx
    CityCanvas.tsx        canvas, pan/zoom, picking
    DetailPanel.tsx
    Legend.tsx
  App.tsx
```
