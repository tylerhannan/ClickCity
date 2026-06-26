import { type TableNode, type EngineCategory } from '../types'
import { ENGINE_COLORS, ENGINE_LABELS, databaseTint } from '../iso/iso'

// Overlay legend: engine colors (always shown) and the databases present, each
// with its tint swatch.
export default function Legend({ tables }: { tables: TableNode[] }) {
  const categories = Array.from(new Set(tables.map((t) => t.category))) as EngineCategory[]
  const databases = Array.from(new Set(tables.map((t) => t.database)))
  const hasActivity = tables.some((t) => (t.activity?.activityScore ?? 0) > 0)

  return (
    <div className="legend">
      <div className="legend-group">
        <div className="legend-head">Engine</div>
        {categories.map((c) => (
          <div className="legend-row" key={c}>
            <span className="swatch" style={{ background: ENGINE_COLORS[c] }} />
            {ENGINE_LABELS[c]}
          </div>
        ))}
      </div>
      <div className="legend-group">
        <div className="legend-head">Database</div>
        {databases.map((d) => (
          <div className="legend-row" key={d}>
            <span className="swatch" style={{ background: databaseTint(d) }} />
            {d}
          </div>
        ))}
      </div>
      {hasActivity && (
        <div className="legend-group">
          <div className="legend-head">Activity</div>
          <div className="legend-row">
            <span className="swatch activity" />
            Pulse glow = query-log activity
          </div>
        </div>
      )}
    </div>
  )
}
