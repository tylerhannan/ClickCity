import { type TableNode, type EngineCategory, tableKey } from '../types'

// ── Isometric geometry ──────────────────────────────────────────────────────
//
// We use a 2:1 dimetric ("isometric") projection. A grid cell (gx, gy) maps to
// a diamond on screen. TILE_W / TILE_H are the half-width / half-height of that
// diamond, so neighbouring diamonds tessellate edge-to-edge.

export const TILE_W = 60
export const TILE_H = 30
// Extra gap between building footprints so the city reads with streets.
const GRID_SPACING = 1.46
const TOP_CORNER_RADIUS_RATIO = 0.4

// Block pixel-height range (before view scaling).
const MIN_BLOCK_H = 24
const MAX_BLOCK_H = 210

export interface PlacedBlock {
  node: TableNode
  gx: number
  gy: number
  heightPx: number
}

export interface View {
  offsetX: number
  offsetY: number
  scale: number
}

// Per-block screen geometry at a given view.
export interface Geometry {
  // ground-diamond centre
  sx: number
  sy: number
  w: number
  h: number
  // pixel height of the block
  H: number
  // centre of the top face (where dependency edges attach)
  topX: number
  topY: number
  // outer silhouette polygon (used for hit-testing)
  hull: Array<[number, number]>
}

// Engine → base color.
export const ENGINE_COLORS: Record<EngineCategory, string> = {
  MergeTree: '#3fa8ff',
  MaterializedView: '#ff5bd6',
  Dictionary: '#ffb65e',
  Distributed: '#35f0ff',
  View: '#84ff8e',
  Other: '#9ca8ff',
}

export const ENGINE_LABELS: Record<EngineCategory, string> = {
  MergeTree: 'MergeTree',
  MaterializedView: 'Materialized View',
  Dictionary: 'Dictionary',
  Distributed: 'Distributed',
  View: 'View',
  Other: 'Other',
}

// ── Layout ───────────────────────────────────────────────────────────────────
//
// Tables are grouped by database. Each database is packed into a roughly-square
// sub-grid, and the sub-grids are stacked along the gy axis with a gap row in
// between so that databases read as distinct neighbourhoods.

export function layout(tables: TableNode[]): PlacedBlock[] {
  const byDb = new Map<string, TableNode[]>()
  for (const t of tables) {
    const group = byDb.get(t.database)
    if (group) group.push(t)
    else byDb.set(t.database, [t])
  }

  const stats = heightStats(tables)
  const blocks: PlacedBlock[] = []
  let rowOffset = 0

  for (const group of byDb.values()) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(group.length)))
    group.forEach((node, i) => {
      blocks.push({
        node,
        gx: i % cols,
        gy: rowOffset + Math.floor(i / cols),
        heightPx: blockHeight(node, stats),
      })
    })
    const rows = Math.ceil(group.length / cols)
    rowOffset += rows + 1 // gap row between databases
  }

  return blocks
}

interface HeightStats {
  rowsToBytes: number
  minNonZeroBytes: number
  maxRefBytes: number
}

function heightStats(tables: TableNode[]): HeightStats {
  const conversionHints = tables
    .filter((t) => t.bytesOnDisk > 0 && t.rows > 0)
    .map((t) => t.bytesOnDisk / t.rows)
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b)
  const rowsToBytes =
    conversionHints.length > 0
      ? conversionHints[Math.floor((conversionHints.length - 1) * 0.5)]
      : 100

  const nonZero = tables
    .map((t) => effectiveMass(t, rowsToBytes))
    .filter((v) => v > 0)
    .sort((a, b) => a - b)
  if (nonZero.length === 0) return { rowsToBytes, minNonZeroBytes: 1, maxRefBytes: 1 }
  const minNonZeroBytes = nonZero[0]
  // Cap at P95 so one giant table doesn't flatten the whole skyline.
  const idx = Math.floor((nonZero.length - 1) * 0.95)
  const maxRefBytes = Math.max(minNonZeroBytes, nonZero[idx])
  return { rowsToBytes, minNonZeroBytes, maxRefBytes }
}

// Log-scaled block height from bytes_on_disk with percentile clamping so
// real-world schemas keep visible height differences.
function blockHeight(node: TableNode, stats: HeightStats): number {
  const bytes = effectiveMass(node, stats.rowsToBytes)
  if (bytes <= 0) return MIN_BLOCK_H
  const clamped = Math.min(bytes, stats.maxRefBytes)
  const lo = Math.log10(stats.minNonZeroBytes + 1)
  const hi = Math.log10(stats.maxRefBytes + 1)
  if (hi <= lo) return (MIN_BLOCK_H + MAX_BLOCK_H) / 2
  const v = (Math.log10(clamped + 1) - lo) / (hi - lo)
  const eased = Math.pow(Math.max(0, Math.min(1, v)), 0.75)
  return MIN_BLOCK_H + eased * (MAX_BLOCK_H - MIN_BLOCK_H)
}

function effectiveMass(node: TableNode, rowsToBytes: number): number {
  if (node.bytesOnDisk > 0) return node.bytesOnDisk
  if (node.rows > 0) return node.rows * rowsToBytes
  return 0
}

export function geometry(b: PlacedBlock, view: View): Geometry {
  const px = (b.gx - b.gy) * TILE_W * GRID_SPACING
  const py = (b.gx + b.gy) * TILE_H * GRID_SPACING
  const sx = view.offsetX + px * view.scale
  const sy = view.offsetY + py * view.scale
  const w = TILE_W * view.scale
  const h = TILE_H * view.scale
  const H = b.heightPx * view.scale
  const topY = sy - H

  // Outer hull of the cuboid: top apex, top-right, ground-right, ground-bottom,
  // ground-left, top-left.
  const hull: Array<[number, number]> = [
    [sx, topY - h],
    [sx + w, topY],
    [sx + w, sy],
    [sx, sy + h],
    [sx - w, sy],
    [sx - w, topY],
  ]

  return { sx, sy, w, h, H, topX: sx, topY, hull }
}

// Fit every block into the canvas and centre it.
export function fitView(placed: PlacedBlock[], cw: number, ch: number): View {
  if (placed.length === 0) return { offsetX: cw / 2, offsetY: ch / 2, scale: 1 }

  const base: View = { offsetX: 0, offsetY: 0, scale: 1 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxHeight = 0
  for (const b of placed) {
    if (b.heightPx > maxHeight) maxHeight = b.heightPx
    const g = geometry(b, base)
    const ground: Array<[number, number]> = [
      [g.sx, g.sy - g.h],
      [g.sx + g.w, g.sy],
      [g.sx, g.sy + g.h],
      [g.sx - g.w, g.sy],
    ]
    for (const [x, y] of ground) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  const contentW = Math.max(1, maxX - minX)
  const contentH = Math.max(1, maxY - minY)
  const scale = Math.min((cw / contentW) * 0.92, (ch / contentH) * 0.86, 2.05)
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  return {
    offsetX: cw / 2 - centerX * scale,
    // Leave extra headroom so tall buildings remain visible at first fit.
    offsetY: ch * 0.62 - centerY * scale + maxHeight * scale * 0.2,
    scale,
  }
}

// ── Color helpers ────────────────────────────────────────────────────────────

interface RGB {
  r: number
  g: number
  b: number
}

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function rgbToCss({ r, g, b }: RGB): string {
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  }
}

function shade(c: RGB, factor: number): RGB {
  return { r: c.r * factor, g: c.g * factor, b: c.b * factor }
}

// Deterministic per-database tint hue. Hashes the name to a stable HSL color.
function dbTintRgb(database: string): RGB {
  let hash = 0
  for (let i = 0; i < database.length; i++) {
    hash = (hash * 31 + database.charCodeAt(i)) >>> 0
  }
  const hue = hash % 360
  return hslToRgb(hue / 360, 0.58, 0.6)
}

function hslToRgb(h: number, s: number, l: number): RGB {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue2rgb = (t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return {
    r: hue2rgb(h + 1 / 3) * 255,
    g: hue2rgb(h) * 255,
    b: hue2rgb(h - 1 / 3) * 255,
  }
}

// Final top-face color: engine base, lightly tinted toward the database hue.
function blockTopColor(node: TableNode): RGB {
  const base = hexToRgb(ENGINE_COLORS[node.category])
  return mix(base, dbTintRgb(node.database), 0.36)
}

// The legend needs the same tint computation in CSS form.
export function databaseTint(database: string): string {
  return rgbToCss(dbTintRgb(database))
}

// ── Drawing ────────────────────────────────────────────────────────────────

export interface DrawOptions {
  selectedKey: string | null
  hoveredKey: string | null
  nowMs: number
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  placed: PlacedBlock[],
  view: View,
  opts: DrawOptions,
): void {
  // Painter's algorithm: back (small gx+gy) to front (large gx+gy).
  const order = [...placed].sort((a, b) => a.gx + a.gy - (b.gx + b.gy))

  // Pre-compute geometry per key for edge drawing.
  const geomByKey = new Map<string, Geometry>()
  for (const b of placed) geomByKey.set(tableKey(b.node), geometry(b, view))

  drawEdges(ctx, placed, geomByKey, opts, 'under')
  drawLots(ctx, order, geomByKey)

  for (const b of order) {
    const g = geomByKey.get(tableKey(b.node))!
    const key = tableKey(b.node)
    drawCuboid(ctx, g, blockTopColor(b.node), {
      key,
      nowMs: opts.nowMs,
      activityScore: b.node.activity?.activityScore ?? 0,
      selected: key === opts.selectedKey,
      hovered: key === opts.hoveredKey,
    })
  }

  drawEdges(ctx, placed, geomByKey, opts, 'over')
}

function drawCuboid(
  ctx: CanvasRenderingContext2D,
  g: Geometry,
  top: RGB,
  state: {
    key: string
    nowMs: number
    activityScore: number
    selected: boolean
    hovered: boolean
  },
): void {
  const { sx, sy, w, h, H, topY } = g
  const left = shade(top, 0.72)
  const right = shade(top, 0.54)
  const pulse = activityPulse(state.key, state.nowMs)
  const glow = state.activityScore * pulse
  const accent = neonAccent(state.key)

  // Concrete lot under each building so street gaps read clearly.
  traceRoundedDiamond(ctx, sx, sy, w * 1.06, h * 1.06, h * 0.26)
  ctx.fillStyle = 'rgba(78, 89, 106, 0.42)'
  ctx.fill()

  // Soft projected shadow gives a more playful "city block" look.
  ctx.beginPath()
  ctx.ellipse(sx + w * 0.18, sy + h * 0.72, w * 0.95, h * 0.52, 0, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(6, 10, 18, 0.16)'
  ctx.fill()

  // Left front face.
  ctx.beginPath()
  ctx.moveTo(sx - w, topY)
  ctx.lineTo(sx, topY + h)
  ctx.lineTo(sx, sy + h)
  ctx.lineTo(sx - w, sy)
  ctx.closePath()
  ctx.fillStyle = rgbToCss(left)
  ctx.fill()
  drawLeftFacadeWindows(ctx, g, state.hovered)

  // Right front face.
  ctx.beginPath()
  ctx.moveTo(sx + w, topY)
  ctx.lineTo(sx, topY + h)
  ctx.lineTo(sx, sy + h)
  ctx.lineTo(sx + w, sy)
  ctx.closePath()
  ctx.fillStyle = rgbToCss(right)
  ctx.fill()
  drawRightFacadeWindows(ctx, g, state.hovered)

  // Top face.
  traceRoundedDiamond(ctx, sx, topY, w, h, Math.min(w, h) * TOP_CORNER_RADIUS_RATIO)
  const lift = Math.min(0.38, glow * 0.32 + (state.hovered ? 0.25 : 0))
  const topGrad = ctx.createLinearGradient(sx - w * 0.6, topY - h, sx + w * 0.6, topY + h)
  topGrad.addColorStop(0, rgbToCss(mix(top, { r: 255, g: 255, b: 255 }, 0.22 + lift * 0.6)))
  topGrad.addColorStop(1, rgbToCss(shade(top, 0.92 - lift * 0.2)))
  ctx.fillStyle = topGrad
  ctx.fill()
  drawRoofUnits(ctx, g, top, state.hovered)

  // Tiny top highlight to make blocks feel less flat.
  ctx.beginPath()
  ctx.moveTo(sx - w * 0.45, topY + h * 0.04)
  ctx.lineTo(sx + w * 0.45, topY - h * 0.14)
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(255,255,255,0.26)'
  ctx.stroke()

  if (glow > 0.02) {
    // Activity halo is independent from size; it visualizes recent workload.
    ctx.save()
    ctx.globalAlpha = Math.min(0.85, glow * 0.95)
    ctx.shadowColor = 'rgba(250, 255, 105, 0.95)'
    ctx.shadowBlur = 10 + glow * 28
    ctx.lineWidth = 1.2 + glow * 1.6
    ctx.strokeStyle = 'rgba(250, 255, 105, 0.75)'
    traceRoundedDiamond(ctx, sx, topY, w, h, Math.min(w, h) * TOP_CORNER_RADIUS_RATIO)
    ctx.stroke()
    ctx.restore()
  }

  // Edge outlines for a crisp pixel-art look.
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.lineWidth = state.selected ? 3.4 : state.hovered ? 2.6 : 1.6
  ctx.strokeStyle = state.selected ? '#fff36b' : state.hovered ? rgbToCss(accent) : 'rgba(20, 26, 42, 0.55)'

  // Top face outline.
  traceRoundedDiamond(ctx, sx, topY, w, h, Math.min(w, h) * TOP_CORNER_RADIUS_RATIO)
  ctx.stroke()

  // Vertical edges down to the ground.
  ctx.beginPath()
  ctx.moveTo(sx - w, topY)
  ctx.lineTo(sx - w, sy)
  ctx.moveTo(sx + w, topY)
  ctx.lineTo(sx + w, sy)
  ctx.moveTo(sx, topY + h)
  ctx.lineTo(sx, sy + h)
  ctx.stroke()

  if (H > 120) {
    ctx.beginPath()
    ctx.moveTo(sx + w * 0.1, topY - h * 0.12)
    ctx.lineTo(sx + w * 0.1, topY - h * 0.52)
    ctx.lineWidth = 1.15
    ctx.strokeStyle = 'rgba(215, 243, 255, 0.86)'
    ctx.stroke()
  }
}

function drawLots(
  ctx: CanvasRenderingContext2D,
  order: PlacedBlock[],
  geomByKey: Map<string, Geometry>,
): void {
  for (const b of order) {
    const g = geomByKey.get(tableKey(b.node))
    if (!g) continue
    const { sx, sy, w, h } = g
    traceRoundedDiamond(ctx, sx, sy, w * 1.12, h * 1.12, h * 0.28)
    ctx.fillStyle = 'rgba(28, 35, 52, 0.22)'
    ctx.fill()
    traceRoundedDiamond(ctx, sx, sy, w * 1.12, h * 1.12, h * 0.28)
    ctx.lineWidth = 0.8
    ctx.strokeStyle = 'rgba(138, 176, 220, 0.24)'
    ctx.stroke()
  }
}

function drawLeftFacadeWindows(ctx: CanvasRenderingContext2D, g: Geometry, hovered: boolean): void {
  const { sx, sy, w, h, topY } = g
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(sx - w, topY)
  ctx.lineTo(sx, topY + h)
  ctx.lineTo(sx, sy + h)
  ctx.lineTo(sx - w, sy)
  ctx.closePath()
  ctx.clip()

  const rowStep = Math.max(7, h * 0.38)
  const colStep = Math.max(9, w * 0.2)
  for (let y = topY + rowStep; y < sy + h - 1; y += rowStep) {
    ctx.beginPath()
    ctx.moveTo(sx - w + 1, y)
    ctx.lineTo(sx - 1, y)
    ctx.strokeStyle = hovered ? 'rgba(147, 233, 255, 0.6)' : 'rgba(175, 225, 255, 0.3)'
    ctx.lineWidth = 0.9
    ctx.stroke()
  }
  for (let x = sx - w + colStep; x < sx - 2; x += colStep) {
    ctx.beginPath()
    ctx.moveTo(x, topY + 1)
    ctx.lineTo(x, sy + h - 1)
    ctx.strokeStyle = 'rgba(26, 33, 45, 0.22)'
    ctx.lineWidth = 0.8
    ctx.stroke()
  }
  ctx.restore()
}

function drawRightFacadeWindows(ctx: CanvasRenderingContext2D, g: Geometry, hovered: boolean): void {
  const { sx, sy, w, h, topY } = g
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(sx + w, topY)
  ctx.lineTo(sx, topY + h)
  ctx.lineTo(sx, sy + h)
  ctx.lineTo(sx + w, sy)
  ctx.closePath()
  ctx.clip()

  const rowStep = Math.max(7, h * 0.38)
  const colStep = Math.max(9, w * 0.2)
  for (let y = topY + rowStep; y < sy + h - 1; y += rowStep) {
    ctx.beginPath()
    ctx.moveTo(sx + 1, y)
    ctx.lineTo(sx + w - 1, y)
    ctx.strokeStyle = hovered ? 'rgba(255, 176, 238, 0.5)' : 'rgba(207, 228, 247, 0.24)'
    ctx.lineWidth = 0.85
    ctx.stroke()
  }
  for (let x = sx + colStep; x < sx + w - 2; x += colStep) {
    ctx.beginPath()
    ctx.moveTo(x, topY + 1)
    ctx.lineTo(x, sy + h - 1)
    ctx.strokeStyle = 'rgba(18, 24, 35, 0.2)'
    ctx.lineWidth = 0.75
    ctx.stroke()
  }
  ctx.restore()
}

function drawRoofUnits(ctx: CanvasRenderingContext2D, g: Geometry, top: RGB, hovered: boolean): void {
  const { sx, w, h, topY } = g
  const roofColor = mix(shade(top, 0.86), { r: 182, g: 192, b: 204 }, 0.52)
  traceRoundedDiamond(ctx, sx + w * 0.06, topY - h * 0.08, w * 0.22, h * 0.22, h * 0.09)
  ctx.fillStyle = rgbToCss(roofColor)
  ctx.fill()
  ctx.lineWidth = 0.9
  ctx.strokeStyle = hovered ? 'rgba(241, 249, 255, 0.78)' : 'rgba(50, 60, 75, 0.45)'
  ctx.stroke()

  traceRoundedDiamond(ctx, sx - w * 0.26, topY + h * 0.01, w * 0.14, h * 0.14, h * 0.06)
  ctx.fillStyle = 'rgba(165, 175, 190, 0.85)'
  ctx.fill()
}

function neonAccent(seed: string): RGB {
  const unit = stableUnit(seed)
  // Neon band between cyan, magenta, and amber.
  const hue = 0.53 + unit * 0.34
  return hslToRgb(hue % 1, 0.9, 0.62)
}

function traceRoundedDiamond(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) * 0.45))
  ctx.beginPath()
  ctx.moveTo(cx - rr, cy - h + rr)
  ctx.quadraticCurveTo(cx, cy - h, cx + rr, cy - h + rr)
  ctx.lineTo(cx + w - rr, cy - rr)
  ctx.quadraticCurveTo(cx + w, cy, cx + w - rr, cy + rr)
  ctx.lineTo(cx + rr, cy + h - rr)
  ctx.quadraticCurveTo(cx, cy + h, cx - rr, cy + h - rr)
  ctx.lineTo(cx - w + rr, cy + rr)
  ctx.quadraticCurveTo(cx - w, cy, cx - w + rr, cy - rr)
  ctx.closePath()
}

function activityPulse(key: string, nowMs: number): number {
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 33 + key.charCodeAt(i)) >>> 0
  const phase = (hash % 360) * (Math.PI / 180)
  const t = nowMs * 0.0042
  // Keep a baseline glow so active tables remain readable between peaks.
  return 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t + phase))
}

function drawEdges(
  ctx: CanvasRenderingContext2D,
  placed: PlacedBlock[],
  geomByKey: Map<string, Geometry>,
  opts: DrawOptions,
  layer: 'under' | 'over',
): void {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const b of placed) {
    const fromKey = tableKey(b.node)
    const from = geomByKey.get(fromKey)
    if (!from) continue
    for (const dep of b.node.dependencies) {
      const to = geomByKey.get(dep)
      if (!to) continue

      const highlight =
        fromKey === opts.selectedKey ||
        dep === opts.selectedKey ||
        fromKey === opts.hoveredKey ||
        dep === opts.hoveredKey
      const midX = (from.topX + to.topX) / 2
      const midY = (from.topY + to.topY) / 2 - 24 * Math.min(1, view0Scale(from, to))
      const edgeSeed = `${fromKey}->${dep}`
      const accent = neonAccent(edgeSeed)
      const base = highlight ? 'rgba(255, 243, 107, 0.95)' : rgbToCss(accent)

      ctx.beginPath()
      ctx.moveTo(from.topX, from.topY)
      ctx.quadraticCurveTo(midX, midY, to.topX, to.topY)
      if (layer === 'under') {
        ctx.lineWidth = highlight ? 6.2 : 4.8
        ctx.strokeStyle = highlight ? 'rgba(255, 244, 164, 0.24)' : 'rgba(121, 227, 255, 0.15)'
        ctx.stroke()
      } else {
        ctx.save()
        ctx.shadowBlur = highlight ? 18 : 11
        ctx.shadowColor = highlight ? 'rgba(255, 242, 122, 0.9)' : `${base.replace('rgb(', 'rgba(').replace(')', ', 0.78)')}`
        ctx.lineWidth = highlight ? 2.8 : 2.05
        ctx.strokeStyle = highlight ? '#fff36b' : base
        ctx.stroke()
        ctx.restore()

        ctx.beginPath()
        ctx.moveTo(from.topX, from.topY)
        ctx.quadraticCurveTo(midX, midY, to.topX, to.topY)
        ctx.lineWidth = 0.95
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.42)'
        ctx.stroke()
      }

      if (layer === 'over') {
        // Animated "data packet" markers make direction and connectivity readable.
        const t = (opts.nowMs * 0.00022 + stableUnit(edgeSeed)) % 1
        const t2 = (t + 0.52) % 1
        const p1 = quadPoint(from.topX, from.topY, midX, midY, to.topX, to.topY, t)
        const p2 = quadPoint(from.topX, from.topY, midX, midY, to.topX, to.topY, t2)
        const packetR = highlight ? 3 : 2.2
        ctx.beginPath()
        ctx.arc(p1.x, p1.y, packetR, 0, Math.PI * 2)
        ctx.fillStyle = highlight ? '#fff8ab' : 'rgba(207, 248, 255, 0.86)'
        ctx.fill()
        ctx.beginPath()
        ctx.arc(p2.x, p2.y, packetR * 0.82, 0, Math.PI * 2)
        ctx.fillStyle = highlight ? 'rgba(255, 241, 163, 0.9)' : 'rgba(182, 238, 255, 0.72)'
        ctx.fill()

        // Marker at the dependency end.
        ctx.beginPath()
        ctx.arc(to.topX, to.topY, highlight ? 5.2 : 3.8, 0, Math.PI * 2)
        ctx.fillStyle = highlight ? '#fff36b' : 'rgba(207, 236, 255, 0.78)'
        ctx.fill()
        ctx.beginPath()
        ctx.arc(to.topX, to.topY, highlight ? 7.8 : 5.7, 0, Math.PI * 2)
        ctx.lineWidth = 1
        ctx.strokeStyle = highlight ? 'rgba(255, 244, 144, 0.72)' : 'rgba(176, 228, 255, 0.42)'
        ctx.stroke()
      }
    }
  }
  ctx.restore()
}

// Bow height scales gently with edge length so short edges stay flat.
function view0Scale(a: Geometry, b: Geometry): number {
  const dx = a.topX - b.topX
  const dy = a.topY - b.topY
  return Math.sqrt(dx * dx + dy * dy) / 200
}

function stableUnit(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967295
}

function quadPoint(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  t: number,
): { x: number; y: number } {
  const u = 1 - t
  return {
    x: u * u * x0 + 2 * u * t * x1 + t * t * x2,
    y: u * u * y0 + 2 * u * t * y1 + t * t * y2,
  }
}

// ── Hit-testing ──────────────────────────────────────────────────────────────

export function hitTest(
  placed: PlacedBlock[],
  view: View,
  x: number,
  y: number,
): TableNode | null {
  // Front-to-back: larger gx+gy is closer to the viewer.
  const order = [...placed].sort((a, b) => b.gx + b.gy - (a.gx + a.gy))
  for (const b of order) {
    if (pointInPolygon(x, y, geometry(b, view).hull)) return b.node
  }
  return null
}

function pointInPolygon(x: number, y: number, poly: Array<[number, number]>): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}
