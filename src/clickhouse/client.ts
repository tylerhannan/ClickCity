import {
  type TableNode,
  type ColumnInfo,
  type TableActivity,
  categorizeEngine,
  tableKey,
} from '../types'

// Connection settings entered on the connection screen.
//
// `url` is the full origin of the ClickHouse HTTP interface, e.g.
//   - local / self-hosted:   http://localhost:8123
//   - ClickHouse Cloud:      https://<host>.clickhouse.cloud:8443
export interface Connection {
  url: string
  user: string
  password: string
}

// Run a query over the ClickHouse HTTP interface and return the `data` rows.
//
// The query is sent as the POST body. We force `FORMAT JSON` so we always get
// back a `{ meta, data, ... }` envelope, and we ask the server to attach CORS
// headers so the browser fetch is allowed cross-origin.
async function query<Row>(
  conn: Connection,
  sql: string,
  params: Record<string, string | number> = {},
): Promise<Row[]> {
  const u = new URL(conn.url)
  // Let the server emit `Access-Control-Allow-Origin: *` on the response.
  u.searchParams.set('add_http_cors_header', '1')
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(`param_${k}`, String(v))
  }

  let res: Response
  try {
    res = await fetch(u.toString(), {
      method: 'POST',
      headers: {
        'X-ClickHouse-User': conn.user,
        'X-ClickHouse-Key': conn.password,
      },
      body: sql + '\nFORMAT JSON',
    })
  } catch (err) {
    // Network-level failure: usually a CORS rejection, wrong scheme/port, or an
    // unreachable host. Surface a hint rather than the opaque "Failed to fetch".
    throw new Error(
      `Could not reach ${conn.url}. Check the URL, scheme (http vs https) and ` +
        `port, and that CORS is allowed for this origin. (${(err as Error).message})`,
    )
  }

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`ClickHouse returned ${res.status}: ${text.slice(0, 500)}`)
  }

  const json = (await res.json()) as { data: Row[] }
  return json.data
}

// Verify a connection is usable. Throws on failure.
export async function ping(conn: Connection): Promise<void> {
  await query(conn, 'SELECT 1')
}

interface TableRow {
  database: string
  name: string
  engine: string
  dependencies_database: string[]
  dependencies_table: string[]
}

interface PartsRow {
  database: string
  table: string
  // sum(...) over UInt64 columns comes back as a string in JSON format.
  bytes_on_disk: string
  rows: string
}

interface TableTotalsRow {
  database: string
  name: string
  total_rows: string | number | null
  total_bytes: string | number | null
}

interface ActivityRow {
  database: string
  table: string
  query_count: string
  rows_read: string
  rows_written: string
  peak_memory: string
}

// QUERY 1 — table metadata from `system.tables`.
const TABLES_SQL = `
SELECT
    database,
    name,
    engine,
    dependencies_database,
    dependencies_table
FROM system.tables
WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
  AND NOT is_temporary
ORDER BY database, name
`.trim()

// QUERY 2 — on-disk size and row counts from active parts in `system.parts`.
const PARTS_SQL = `
SELECT
    database,
    table,
    sum(bytes_on_disk) AS bytes_on_disk,
    sum(rows)          AS rows
FROM system.parts
WHERE active
GROUP BY database, table
`.trim()

// Fallback for environments where `system.parts` is not accessible.
const TOTAL_ROWS_SQL = `
SELECT
    database,
    name,
    total_rows,
    total_bytes
FROM system.tables
WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
  AND NOT is_temporary
`.trim()

function activitySql(windowMinutes: number): string {
  const minutes = Math.max(1, Math.floor(windowMinutes))
  return `
SELECT
    tupleElement(pair, 1) AS database,
    tupleElement(pair, 2) AS table,
    count()               AS query_count,
    sum(read_rows)        AS rows_read,
    sum(written_rows)     AS rows_written,
    max(memory_usage)     AS peak_memory
FROM
(
    SELECT
        arrayJoin(arrayZip(databases, tables)) AS pair,
        read_rows,
        written_rows,
        memory_usage
    FROM system.query_log
    WHERE event_time >= now() - INTERVAL ${minutes} MINUTE
      AND type = 'QueryFinish'
      AND length(databases) > 0
      AND length(tables) > 0
)
GROUP BY database, table
  `.trim()
}

// Fetch the whole schema: run both queries and merge them into TableNodes.
export async function fetchSchema(conn: Connection): Promise<TableNode[]> {
  const tables = await query<TableRow>(conn, TABLES_SQL)
  let parts: PartsRow[] = []
  // Always gather table-level totals as a fallback/augmentation: some roles can
  // query `system.parts` but still get sparse/partial coverage.
  const fallbackRowsByKey = new Map<string, number>()
  const fallbackBytesByKey = new Map<string, number>()
  const totals = await query<TableTotalsRow>(conn, TOTAL_ROWS_SQL).catch(() => [])
  for (const t of totals) {
    const key = `${t.database}.${t.name}`
    const rows = Number(t.total_rows ?? 0)
    const bytes = Number(t.total_bytes ?? 0)
    fallbackRowsByKey.set(key, Number.isFinite(rows) ? rows : 0)
    fallbackBytesByKey.set(key, Number.isFinite(bytes) ? bytes : 0)
  }
  try {
    parts = await query<PartsRow>(conn, PARTS_SQL)
  } catch (err) {
    // Some users can read `system.tables` but not `system.parts`.
    // In that case try table-level totals as a fallback.
    if (!isLikelyAccessOrSystemRestriction(err)) throw err
  }

  // Index part aggregates by "database.table".
  const sizeByKey = new Map<string, { bytes: number; rows: number }>()
  for (const p of parts) {
    sizeByKey.set(`${p.database}.${p.table}`, {
      bytes: Number(p.bytes_on_disk),
      rows: Number(p.rows),
    })
  }

  const nodes = tables.map((t): TableNode => {
    const key = tableKey(t)
    const fromParts = sizeByKey.get(key)
    const fallbackRows = fallbackRowsByKey.get(key) ?? 0
    const fallbackBytes = fallbackBytesByKey.get(key) ?? 0
    const size = fromParts
      ? {
          // Keep part-level values when present, but fill obvious gaps from
          // table totals so row counts don't collapse to zero.
          bytes: fromParts.bytes > 0 ? fromParts.bytes : fallbackBytes,
          rows: fromParts.rows > 0 ? fromParts.rows : fallbackRows,
        }
      : {
          bytes: fallbackBytes,
          rows: fallbackRows,
        }

    // `dependencies_database` and `dependencies_table` are parallel arrays.
    const allDependencies: string[] = []
    const deps = t.dependencies_table ?? []
    for (let i = 0; i < deps.length; i++) {
      const db = t.dependencies_database?.[i] ?? t.database
      allDependencies.push(`${db}.${deps[i]}`)
    }

    return {
      database: t.database,
      name: t.name,
      engine: t.engine,
      category: categorizeEngine(t.engine),
      bytesOnDisk: size.bytes,
      rows: size.rows,
      dependencies: allDependencies,
    }
  })

  // Keep only resolvable edges for rendering, but preserve unresolved targets so
  // the detail panel can explain why dependency counts may differ from drawn lines.
  const knownKeys = new Set(nodes.map((n) => tableKey(n)))
  for (const node of nodes) {
    const resolved: string[] = []
    const unresolved: string[] = []
    for (const dep of node.dependencies) {
      if (knownKeys.has(dep)) resolved.push(dep)
      else unresolved.push(dep)
    }
    node.dependencies = resolved
    if (unresolved.length > 0) node.unresolvedDependencies = unresolved
  }

  let workloadUnavailable = false
  let activityByKey = new Map<string, TableActivity>()
  try {
    activityByKey = await fetchActivityByTable(conn)
  } catch {
    // Keep the schema visible even when `system.query_log` is restricted. The
    // renderer uses this flag to show neutral structural windows rather than
    // pretending to know recent read/write workload.
    workloadUnavailable = true
  }
  for (const node of nodes) {
    const activity = activityByKey.get(tableKey(node))
    if (activity) node.activity = activity
    else if (workloadUnavailable) node.workloadUnavailable = true
  }
  return nodes
}

function isLikelyAccessOrSystemRestriction(err: unknown): boolean {
  const message = (err as Error)?.message ?? ''
  return (
    message.includes('ACCESS_DENIED') ||
    message.includes('Not enough privileges') ||
    message.includes('grant SELECT ON system.parts') ||
    message.includes('Unknown table expression identifier')
  )
}

// Optional query: recent table activity from `system.query_log`.
//
// Some deployments deny access to query logs or disable them entirely. Callers
// should treat failures as non-fatal and keep rendering the static schema.
export async function fetchActivityByTable(
  conn: Connection,
  windowMinutes = 30,
): Promise<Map<string, TableActivity>> {
  const rows = await query<ActivityRow>(conn, activitySql(windowMinutes))
  if (rows.length === 0) return new Map()

  let maxCount = 1
  let maxRows = 1
  let maxMemory = 1
  const parsed = rows.map((r) => {
    const queryCount = Number(r.query_count)
    const rowsRead = Number(r.rows_read)
    const rowsWritten = Number(r.rows_written)
    const peakMemory = Number(r.peak_memory)
    if (queryCount > maxCount) maxCount = queryCount
    if (rowsRead + rowsWritten > maxRows) maxRows = rowsRead + rowsWritten
    if (peakMemory > maxMemory) maxMemory = peakMemory
    return {
      key: `${r.database}.${r.table}`,
      queryCount,
      rowsRead,
      rowsWritten,
      peakMemory,
    }
  })

  const byKey = new Map<string, TableActivity>()
  for (const p of parsed) {
    const countScore = p.queryCount / maxCount
    const throughputScore = (p.rowsRead + p.rowsWritten) / maxRows
    const memoryScore = p.peakMemory / maxMemory
    const activityScore = Math.max(
      0,
      Math.min(1, countScore * 0.5 + throughputScore * 0.35 + memoryScore * 0.15),
    )
    byKey.set(p.key, { ...p, activityScore })
  }
  return byKey
}

// Fetch the column list for one table, lazily, when its detail panel opens.
export async function fetchColumns(
  conn: Connection,
  database: string,
  table: string,
): Promise<ColumnInfo[]> {
  return query<ColumnInfo>(
    conn,
    `SELECT name, type
     FROM system.columns
     WHERE database = {db:String} AND table = {tbl:String}
     ORDER BY position`,
    { db: database, tbl: table },
  )
}
