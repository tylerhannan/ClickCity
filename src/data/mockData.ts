import { type TableNode, categorizeEngine } from '../types'

// Hardcoded schema used for developing the visuals without a live ClickHouse.
// Spans three databases with a mix of engines and several dependency edges
// (MV chains, a cross-database MV, a Distributed table, plain Views).
interface MockSpec {
  database: string
  name: string
  engine: string
  bytesOnDisk: number
  rows: number
  dependencies?: string[]
  activity?: {
    queryCount: number
    rowsRead: number
    rowsWritten: number
    peakMemory: number
    activityScore: number
  }
  columns: { name: string; type: string }[]
}

const SPECS: MockSpec[] = [
  // ── analytics ───────────────────────────────────────────────────────────
  {
    database: 'analytics',
    name: 'events',
    engine: 'MergeTree',
    bytesOnDisk: 52_000_000_000,
    rows: 4_800_000_000,
    activity: {
      queryCount: 540,
      rowsRead: 18_400_000_000,
      rowsWritten: 128_000_000,
      peakMemory: 1_640_000_000,
      activityScore: 0.98,
    },
    columns: [
      { name: 'event_time', type: 'DateTime' },
      { name: 'user_id', type: 'UInt64' },
      { name: 'event_type', type: 'LowCardinality(String)' },
      { name: 'url', type: 'String' },
      { name: 'country', type: 'FixedString(2)' },
    ],
  },
  {
    database: 'analytics',
    name: 'events_dist',
    engine: 'Distributed',
    bytesOnDisk: 0,
    rows: 0,
    dependencies: ['analytics.events'],
    activity: {
      queryCount: 230,
      rowsRead: 9_200_000_000,
      rowsWritten: 0,
      peakMemory: 740_000_000,
      activityScore: 0.78,
    },
    columns: [
      { name: 'event_time', type: 'DateTime' },
      { name: 'user_id', type: 'UInt64' },
      { name: 'event_type', type: 'LowCardinality(String)' },
    ],
  },
  {
    database: 'analytics',
    name: 'daily_rollup',
    engine: 'SummingMergeTree',
    bytesOnDisk: 1_400_000_000,
    rows: 26_000_000,
    activity: {
      queryCount: 90,
      rowsRead: 710_000_000,
      rowsWritten: 3_400_000,
      peakMemory: 210_000_000,
      activityScore: 0.52,
    },
    columns: [
      { name: 'day', type: 'Date' },
      { name: 'event_type', type: 'LowCardinality(String)' },
      { name: 'hits', type: 'UInt64' },
    ],
  },
  {
    database: 'analytics',
    name: 'daily_rollup_mv',
    engine: 'MaterializedView',
    bytesOnDisk: 0,
    rows: 0,
    dependencies: ['analytics.events', 'analytics.daily_rollup'],
    activity: {
      queryCount: 55,
      rowsRead: 190_000_000,
      rowsWritten: 190_000_000,
      peakMemory: 170_000_000,
      activityScore: 0.46,
    },
    columns: [
      { name: 'day', type: 'Date' },
      { name: 'event_type', type: 'LowCardinality(String)' },
      { name: 'hits', type: 'UInt64' },
    ],
  },
  {
    database: 'analytics',
    name: 'top_pages',
    engine: 'View',
    bytesOnDisk: 0,
    rows: 0,
    dependencies: ['analytics.events'],
    activity: {
      queryCount: 180,
      rowsRead: 2_600_000_000,
      rowsWritten: 0,
      peakMemory: 520_000_000,
      activityScore: 0.7,
    },
    columns: [
      { name: 'url', type: 'String' },
      { name: 'hits', type: 'UInt64' },
    ],
  },
  {
    database: 'analytics',
    name: 'users',
    engine: 'ReplacingMergeTree',
    bytesOnDisk: 3_100_000_000,
    rows: 92_000_000,
    activity: {
      queryCount: 120,
      rowsRead: 490_000_000,
      rowsWritten: 15_000_000,
      peakMemory: 240_000_000,
      activityScore: 0.57,
    },
    columns: [
      { name: 'user_id', type: 'UInt64' },
      { name: 'signup_date', type: 'Date' },
      { name: 'plan', type: 'LowCardinality(String)' },
    ],
  },
  {
    database: 'analytics',
    name: 'geo_dict',
    engine: 'Dictionary',
    bytesOnDisk: 18_000_000,
    rows: 250_000,
    activity: {
      queryCount: 26,
      rowsRead: 84_000_000,
      rowsWritten: 0,
      peakMemory: 44_000_000,
      activityScore: 0.29,
    },
    columns: [
      { name: 'ip_prefix', type: 'String' },
      { name: 'country', type: 'String' },
      { name: 'city', type: 'String' },
    ],
  },

  // ── staging ─────────────────────────────────────────────────────────────
  {
    database: 'staging',
    name: 'raw_events',
    engine: 'MergeTree',
    bytesOnDisk: 78_000_000_000,
    rows: 6_100_000_000,
    activity: {
      queryCount: 310,
      rowsRead: 1_200_000_000,
      rowsWritten: 7_900_000_000,
      peakMemory: 860_000_000,
      activityScore: 0.86,
    },
    columns: [
      { name: 'raw', type: 'String' },
      { name: 'received_at', type: 'DateTime64(3)' },
    ],
  },
  {
    database: 'staging',
    name: 'raw_events_mv',
    engine: 'MaterializedView',
    bytesOnDisk: 0,
    rows: 0,
    dependencies: ['analytics.events'],
    activity: {
      queryCount: 70,
      rowsRead: 220_000_000,
      rowsWritten: 220_000_000,
      peakMemory: 155_000_000,
      activityScore: 0.44,
    },
    columns: [
      { name: 'event_time', type: 'DateTime' },
      { name: 'user_id', type: 'UInt64' },
    ],
  },
  {
    database: 'staging',
    name: 'import_buffer',
    engine: 'MergeTree',
    bytesOnDisk: 240_000_000,
    rows: 1_900_000,
    activity: {
      queryCount: 38,
      rowsRead: 30_000_000,
      rowsWritten: 260_000_000,
      peakMemory: 120_000_000,
      activityScore: 0.34,
    },
    columns: [
      { name: 'batch_id', type: 'UUID' },
      { name: 'payload', type: 'String' },
    ],
  },

  // ── shop ────────────────────────────────────────────────────────────────
  {
    database: 'shop',
    name: 'orders',
    engine: 'MergeTree',
    bytesOnDisk: 6_700_000_000,
    rows: 140_000_000,
    activity: {
      queryCount: 190,
      rowsRead: 1_100_000_000,
      rowsWritten: 28_000_000,
      peakMemory: 470_000_000,
      activityScore: 0.67,
    },
    columns: [
      { name: 'order_id', type: 'UInt64' },
      { name: 'customer_id', type: 'UInt64' },
      { name: 'total', type: 'Decimal(12, 2)' },
      { name: 'created_at', type: 'DateTime' },
    ],
  },
  {
    database: 'shop',
    name: 'order_items',
    engine: 'MergeTree',
    bytesOnDisk: 11_500_000_000,
    rows: 420_000_000,
    activity: {
      queryCount: 165,
      rowsRead: 1_420_000_000,
      rowsWritten: 44_000_000,
      peakMemory: 510_000_000,
      activityScore: 0.69,
    },
    columns: [
      { name: 'order_id', type: 'UInt64' },
      { name: 'sku', type: 'String' },
      { name: 'qty', type: 'UInt32' },
    ],
  },
  {
    database: 'shop',
    name: 'customers',
    engine: 'ReplacingMergeTree',
    bytesOnDisk: 980_000_000,
    rows: 31_000_000,
    activity: {
      queryCount: 72,
      rowsRead: 170_000_000,
      rowsWritten: 9_500_000,
      peakMemory: 160_000_000,
      activityScore: 0.4,
    },
    columns: [
      { name: 'customer_id', type: 'UInt64' },
      { name: 'email', type: 'String' },
      { name: 'country', type: 'FixedString(2)' },
    ],
  },
  {
    database: 'shop',
    name: 'revenue_daily',
    engine: 'SummingMergeTree',
    bytesOnDisk: 320_000_000,
    rows: 5_400_000,
    activity: {
      queryCount: 54,
      rowsRead: 85_000_000,
      rowsWritten: 2_200_000,
      peakMemory: 75_000_000,
      activityScore: 0.31,
    },
    columns: [
      { name: 'day', type: 'Date' },
      { name: 'revenue', type: 'Decimal(18, 2)' },
    ],
  },
  {
    database: 'shop',
    name: 'revenue_mv',
    engine: 'MaterializedView',
    bytesOnDisk: 0,
    rows: 0,
    dependencies: ['shop.revenue_daily', 'shop.orders'],
    activity: {
      queryCount: 41,
      rowsRead: 46_000_000,
      rowsWritten: 46_000_000,
      peakMemory: 60_000_000,
      activityScore: 0.28,
    },
    columns: [
      { name: 'day', type: 'Date' },
      { name: 'revenue', type: 'Decimal(18, 2)' },
    ],
  },
]

export const MOCK_TABLES: TableNode[] = SPECS.map((s) => ({
  database: s.database,
  name: s.name,
  engine: s.engine,
  category: categorizeEngine(s.engine),
  bytesOnDisk: s.bytesOnDisk,
  rows: s.rows,
  dependencies: s.dependencies ?? [],
  activity: s.activity,
  columns: s.columns,
}))
