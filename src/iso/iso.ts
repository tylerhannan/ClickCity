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
const TOP_CORNER_RADIUS_RATIO = 0.14

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
  MergeTree: '#2b3f57',
  MaterializedView: '#452a57',
  Dictionary: '#594230',
  Distributed: '#235061',
  View: '#2a574a',
  Other: '#37405a',
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
  return hslToRgb(hue / 360, 0.44, 0.52)
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
  return mix(base, dbTintRgb(node.database), 0.18)
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

  drawAtmosphere(ctx, opts.nowMs)
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
  const left = shade(top, 0.58)
  const right = shade(top, 0.42)
  const pulse = activityPulse(state.key, state.nowMs)
  const glow = state.activityScore * pulse
  const accent = neonAccent(state.key)

  // Dark lot under each building so street gaps read like alleys.
  traceRoundedDiamond(ctx, sx, sy, w * 1.04, h * 1.04, h * 0.12)
  ctx.fillStyle = 'rgba(10, 14, 23, 0.58)'
  ctx.fill()

  // Diffuse shadow for hazy depth.
  ctx.beginPath()
  ctx.ellipse(sx + w * 0.22, sy + h * 0.78, w * 1.02, h * 0.58, 0, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(2, 5, 12, 0.24)'
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
  drawLeftFacadeWindows(ctx, g, state.key, state.hovered)

  // Right front face.
  ctx.beginPath()
  ctx.moveTo(sx + w, topY)
  ctx.lineTo(sx, topY + h)
  ctx.lineTo(sx, sy + h)
  ctx.lineTo(sx + w, sy)
  ctx.closePath()
  ctx.fillStyle = rgbToCss(right)
  ctx.fill()
  drawRightFacadeWindows(ctx, g, state.key, state.hovered)

  // Top face.
  traceRoundedDiamond(ctx, sx, topY, w, h, Math.min(w, h) * TOP_CORNER_RADIUS_RATIO)
  const lift = Math.min(0.24, glow * 0.2 + (state.hovered ? 0.14 : 0))
  const topGrad = ctx.createLinearGradient(sx - w * 0.6, topY - h, sx + w * 0.6, topY + h)
  topGrad.addColorStop(0, rgbToCss(mix(top, { r: 190, g: 210, b: 232 }, 0.14 + lift * 0.4)))
  topGrad.addColorStop(1, rgbToCss(shade(top, 0.72)))
  ctx.fillStyle = topGrad
  ctx.fill()
  drawRoofUnits(ctx, g, top, state.hovered)

  // Tiny top highlight to make blocks feel less flat.
  ctx.beginPath()
  ctx.moveTo(sx - w * 0.45, topY + h * 0.04)
  ctx.lineTo(sx + w * 0.45, topY - h * 0.14)
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(206, 234, 255, 0.2)'
  ctx.stroke()

  if (glow > 0.02) {
    // Activity halo is independent from size; it visualizes recent workload.
    ctx.save()
    ctx.globalAlpha = Math.min(0.85, glow * 0.95)
    ctx.shadowColor = 'rgba(82, 239, 255, 0.85)'
    ctx.shadowBlur = 8 + glow * 22
    ctx.lineWidth = 1.2 + glow * 1.6
    ctx.strokeStyle = 'rgba(102, 240, 255, 0.58)'
    traceRoundedDiamond(ctx, sx, topY, w, h, Math.min(w, h) * TOP_CORNER_RADIUS_RATIO)
    ctx.stroke()
    ctx.restore()
  }

  // Edge outlines for a crisp pixel-art look.
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.lineWidth = state.selected ? 3 : state.hovered ? 2.2 : 1.35
  ctx.strokeStyle = state.selected ? '#ffe77f' : state.hovered ? rgbToCss(accent) : 'rgba(18, 24, 38, 0.72)'

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
    ctx.strokeStyle = 'rgba(255, 72, 72, 0.76)'
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
    traceRoundedDiamond(ctx, sx, sy, w * 1.12, h * 1.12, h * 0.1)
    ctx.fillStyle = 'rgba(6, 10, 18, 0.36)'
    ctx.fill()
    traceRoundedDiamond(ctx, sx, sy, w * 1.12, h * 1.12, h * 0.1)
    ctx.lineWidth = 0.8
    ctx.strokeStyle = 'rgba(88, 120, 162, 0.2)'
    ctx.stroke()
  }
}

function drawLeftFacadeWindows(
  ctx: CanvasRenderingContext2D,
  g: Geometry,
  key: string,
  hovered: boolean,
): void {
  const { sx, sy, w, h, topY } = g
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(sx - w, topY)
  ctx.lineTo(sx, topY + h)
  ctx.lineTo(sx, sy + h)
  ctx.lineTo(sx - w, sy)
  ctx.closePath()
  ctx.clip()

  const rowStep = Math.max(9, h * 0.34)
  const colStep = Math.max(8, w * 0.14)
  const winW = Math.max(2.2, colStep * 0.46)
  const winH = Math.max(2.2, rowStep * 0.22)
  let row = 0
  for (let y = topY + rowStep * 0.6; y < sy + h - rowStep * 0.35; y += rowStep) {
    let col = 0
    for (let x = sx - w + colStep * 0.55; x < sx - colStep * 0.25; x += colStep) {
      const lit = stableUnit(`${key}:L:${row}:${col}`) > 0.62
      const neon = stableUnit(`${key}:Ln:${row}:${col}`) > 0.94
      if (lit || neon || hovered) {
        ctx.fillStyle = neon
          ? 'rgba(255, 81, 217, 0.78)'
          : hovered
            ? 'rgba(138, 236, 255, 0.66)'
            : 'rgba(198, 225, 255, 0.58)'
      } else {
        ctx.fillStyle = 'rgba(14, 20, 32, 0.62)'
      }
      ctx.fillRect(x - winW * 0.5, y - winH * 0.5, winW, winH)
      col++
    }
    row++
  }
  ctx.restore()
}

function drawRightFacadeWindows(
  ctx: CanvasRenderingContext2D,
  g: Geometry,
  key: string,
  hovered: boolean,
): void {
  const { sx, sy, w, h, topY } = g
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(sx + w, topY)
  ctx.lineTo(sx, topY + h)
  ctx.lineTo(sx, sy + h)
  ctx.lineTo(sx + w, sy)
  ctx.closePath()
  ctx.clip()

  const rowStep = Math.max(9, h * 0.34)
  const colStep = Math.max(8, w * 0.14)
  const winW = Math.max(2.2, colStep * 0.46)
  const winH = Math.max(2.2, rowStep * 0.22)
  let row = 0
  for (let y = topY + rowStep * 0.6; y < sy + h - rowStep * 0.35; y += rowStep) {
    let col = 0
    for (let x = sx + colStep * 0.2; x < sx + w - colStep * 0.2; x += colStep) {
      const lit = stableUnit(`${key}:R:${row}:${col}`) > 0.64
      const neon = stableUnit(`${key}:Rn:${row}:${col}`) > 0.95
      if (lit || neon || hovered) {
        ctx.fillStyle = neon
          ? 'rgba(65, 239, 255, 0.78)'
          : hovered
            ? 'rgba(255, 176, 240, 0.6)'
            : 'rgba(188, 220, 248, 0.54)'
      } else {
        ctx.fillStyle = 'rgba(12, 18, 29, 0.62)'
      }
      ctx.fillRect(x - winW * 0.5, y - winH * 0.5, winW, winH)
      col++
    }
    row++
  }
  ctx.restore()
}

function drawRoofUnits(ctx: CanvasRenderingContext2D, g: Geometry, top: RGB, hovered: boolean): void {
  const { sx, w, h, topY } = g
  const roofColor = mix(shade(top, 0.52), { r: 120, g: 130, b: 146 }, 0.3)
  traceRoundedDiamond(ctx, sx + w * 0.06, topY - h * 0.08, w * 0.2, h * 0.18, h * 0.03)
  ctx.fillStyle = rgbToCss(roofColor)
  ctx.fill()
  ctx.lineWidth = 0.9
  ctx.strokeStyle = hovered ? 'rgba(241, 249, 255, 0.7)' : 'rgba(28, 36, 52, 0.78)'
  ctx.stroke()

  traceRoundedDiamond(ctx, sx - w * 0.26, topY + h * 0.01, w * 0.12, h * 0.12, h * 0.03)
  ctx.fillStyle = 'rgba(108, 118, 134, 0.92)'
  ctx.fill()
}

function neonAccent(seed: string): RGB {
  const unit = stableUnit(seed)
  // Neon band between cyan and magenta.
  const hue = 0.52 + unit * 0.26
  return hslToRgb(hue % 1, 0.82, 0.62)
}

function drawAtmosphere(ctx: CanvasRenderingContext2D, nowMs: number): void {
  const cw = ctx.canvas.width
  const ch = ctx.canvas.height
  const fog = ctx.createRadialGradient(cw * 0.64, ch * 0.38, ch * 0.08, cw * 0.62, ch * 0.52, ch * 0.9)
  fog.addColorStop(0, 'rgba(34, 18, 70, 0.24)')
  fog.addColorStop(0.45, 'rgba(12, 20, 44, 0.18)')
  fog.addColorStop(1, 'rgba(4, 8, 18, 0.62)')
  ctx.fillStyle = fog
  ctx.fillRect(0, 0, cw, ch)

  const haze = ctx.createLinearGradient(0, ch * 0.2, 0, ch)
  haze.addColorStop(0, 'rgba(18, 27, 48, 0.08)')
  haze.addColorStop(1, 'rgba(7, 10, 18, 0.35)')
  ctx.fillStyle = haze
  ctx.fillRect(0, 0, cw, ch)

  // Sparse rain streaks for cyberpunk atmosphere.
  ctx.save()
  ctx.strokeStyle = 'rgba(170, 208, 255, 0.08)'
  ctx.lineWidth = 1
  const drift = nowMs * 0.015
  for (let i = 0; i < 70; i++) {
    const x = ((i * 97.13 + drift * 1.7) % (cw + 80)) - 40
    const y = ((i * 53.79 + drift * 2.6) % (ch + 120)) - 60
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x - 6, y + 16)
    ctx.stroke()
  }
  ctx.restore()
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
