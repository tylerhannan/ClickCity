// Shared domain types for ClickCity.

// Coarse engine buckets that drive block color. The raw engine string from
// `system.tables` (e.g. "ReplicatedMergeTree", "MaterializedView") is mapped
// onto one of these.
export type EngineCategory =
  | 'MergeTree'
  | 'MaterializedView'
  | 'Dictionary'
  | 'Distributed'
  | 'View'
  | 'Other'

export interface ColumnInfo {
  name: string
  type: string
}

export interface TableActivity {
  queryCount: number
  rowsRead: number
  rowsWritten: number
  peakMemory: number
  // Normalized in [0, 1] for visual overlays.
  activityScore: number
}

// One table = one voxel block in the city.
export interface TableNode {
  database: string
  name: string
  engine: string
  category: EngineCategory
  bytesOnDisk: number
  rows: number
  // Fully-qualified "database.table" keys this table depends on / feeds:
  // materialized-view targets, the underlying table of a Distributed engine, etc.
  dependencies: string[]
  // Optional pre-loaded columns (used by mock data). For a live connection the
  // detail panel fetches columns on demand from `system.columns`.
  columns?: ColumnInfo[]
  // Optional activity derived from recent `system.query_log`.
  activity?: TableActivity
  // True when recent workload could not be fetched, usually because
  // `system.query_log` is not readable for the connected user.
  workloadUnavailable?: boolean
}

// Stable key used to cross-reference tables (dependency edges, selection).
export function tableKey(t: { database: string; name: string }): string {
  return `${t.database}.${t.name}`
}

// Map a raw ClickHouse engine string onto a coarse category.
export function categorizeEngine(engine: string): EngineCategory {
  const e = engine ?? ''
  if (e === 'MaterializedView') return 'MaterializedView'
  if (e === 'Dictionary') return 'Dictionary'
  if (e === 'Distributed') return 'Distributed'
  if (e === 'View' || e === 'LiveView' || e === 'WindowView') return 'View'
  if (e.includes('MergeTree')) return 'MergeTree'
  return 'Other'
}
