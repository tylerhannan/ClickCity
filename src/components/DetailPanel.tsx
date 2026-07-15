import { useEffect, useState } from 'react'
import { type TableNode, type ColumnInfo } from '../types'
import { type Connection, fetchColumns } from '../clickhouse/client'
import { ENGINE_COLORS, ENGINE_LABELS } from '../iso/iso'

interface Props {
  table: TableNode
  conn: Connection | null
  onClose: () => void
}

// Side drawer with the details of the selected table. Columns come from the
// node itself (mock data) or are fetched lazily from `system.columns` (live).
export default function DetailPanel({ table, conn, onClose }: Props) {
  const [columns, setColumns] = useState<ColumnInfo[] | null>(table.columns ?? null)
  const [colError, setColError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setColumns(table.columns ?? null)
    setColError(null)
    if (table.columns || !conn) return

    let cancelled = false
    setLoading(true)
    fetchColumns(conn, table.database, table.name)
      .then((cols) => {
        if (!cancelled) setColumns(cols)
      })
      .catch((e: Error) => {
        if (!cancelled) setColError(e.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [table, conn])

  return (
    <aside className="detail-panel">
      <button className="close" onClick={onClose} aria-label="Close">
        ×
      </button>

      <div className="detail-engine" style={{ background: ENGINE_COLORS[table.category] }}>
        {ENGINE_LABELS[table.category]}
      </div>
      <h2 className="detail-title">{table.name}</h2>
      <div className="detail-db">{table.database}</div>

      <dl className="detail-stats">
        <div>
          <dt>Engine</dt>
          <dd>{table.engine}</dd>
        </div>
        <div>
          <dt>Disk size</dt>
          <dd>{formatBytes(table.bytesOnDisk)}</dd>
        </div>
        <div>
          <dt>Rows</dt>
          <dd>{formatCount(table.rows)}</dd>
        </div>
      </dl>

      {table.activity && (
        <section className="detail-section">
          <h3>Recent activity (query_log)</h3>
          <dl className="detail-stats activity-stats">
            <div>
              <dt>Queries</dt>
              <dd>{formatCount(table.activity.queryCount)}</dd>
            </div>
            <div>
              <dt>Rows read</dt>
              <dd>{formatCount(table.activity.rowsRead)}</dd>
            </div>
            <div>
              <dt>Rows written</dt>
              <dd>{formatCount(table.activity.rowsWritten)}</dd>
            </div>
            <div>
              <dt>Peak memory</dt>
              <dd>{formatBytes(table.activity.peakMemory)}</dd>
            </div>
          </dl>
        </section>
      )}
      {!table.activity && table.workloadUnavailable && (
        <section className="detail-section">
          <h3>Recent activity (query_log)</h3>
          <div className="muted">
            Workload unavailable for this connection. The user may not have SELECT access
            on system.query_log.
          </div>
        </section>
      )}

      {table.dependencies.length > 0 && (
        <section className="detail-section">
          <h3>Dependencies (rendered: {table.dependencies.length})</h3>
          <ul className="dep-list">
            {table.dependencies.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </section>
      )}
      {(table.unresolvedDependencies?.length ?? 0) > 0 && (
        <section className="detail-section">
          <h3>Dependencies (unresolved: {table.unresolvedDependencies!.length})</h3>
          <div className="muted">
            These targets are reported by ClickHouse but are outside the visible graph.
          </div>
          <ul className="dep-list">
            {table.unresolvedDependencies!.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="detail-section">
        <h3>Columns{columns ? ` (${columns.length})` : ''}</h3>
        {loading && <div className="muted">Loading columns…</div>}
        {colError && <div className="error small">{colError}</div>}
        {columns && columns.length > 0 && (
          <table className="col-table">
            <tbody>
              {columns.map((c) => (
                <tr key={c.name}>
                  <td className="col-name">{c.name}</td>
                  <td className="col-type">{c.type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {columns && columns.length === 0 && <div className="muted">No columns.</div>}
      </section>
    </aside>
  )
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 && i > 0 ? 2 : 1)} ${units[i]}`
}

function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  return n.toLocaleString('en-US')
}
