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

interface SceneBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
  centerX: number
  centerY: number
  width: number
  height: number
}

interface WorkloadScale {
  maxRowsRead: number
  maxRowsWritten: number
  maxQueryCount: number
  maxFootprint: number
}

interface WorkloadVisual {
  readIntensity: number
  writeIntensity: number
  queryIntensity: number
  activityScore: number
  structuralIntensity: number
  unavailable: boolean
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
  for (const b of placed) {
    const g = geometry(b, base)
    for (const [x, y] of g.hull) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  const contentW = Math.max(1, maxX - minX)
  const contentH = Math.max(1, maxY - minY)
  const scale = Math.min((cw / contentW) * 0.9, (ch / contentH) * 0.82, 2.05)
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  return {
    offsetX: cw / 2 - centerX * scale,
    // Bias slightly low so rooftops have air while the city still sits in frame.
    offsetY: ch * 0.52 - centerY * scale,
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

function rgbToRgba({ r, g, b }: RGB, a: number): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`
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
  const bounds = sceneBounds(geomByKey)
  const workloadScale = computeWorkloadScale(placed)

  drawAtmosphere(ctx, opts.nowMs, bounds)
  drawCityPlane(ctx, placed, view, bounds, opts.nowMs)
  drawEdges(ctx, placed, geomByKey, opts, 'under')
  drawLots(ctx, order, geomByKey)

  for (const b of order) {
    const g = geomByKey.get(tableKey(b.node))!
    const key = tableKey(b.node)
    drawCuboid(ctx, g, blockTopColor(b.node), {
      key,
      nowMs: opts.nowMs,
      activityScore: b.node.activity?.activityScore ?? 0,
      workload: workloadForNode(b.node, workloadScale),
      selected: key === opts.selectedKey,
      hovered: key === opts.hoveredKey,
    })
  }

  drawEdges(ctx, placed, geomByKey, opts, 'over')
}

function sceneBounds(geomByKey: Map<string, Geometry>): SceneBounds {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const g of geomByKey.values()) {
    for (const [x, y] of g.hull) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (!Number.isFinite(minX)) {
    minX = 0
    minY = 0
    maxX = 1
    maxY = 1
  }
  const width = Math.max(1, maxX - minX)
  const height = Math.max(1, maxY - minY)
  return {
    minX,
    minY,
    maxX,
    maxY,
    width,
    height,
    centerX: minX + width / 2,
    centerY: minY + height / 2,
  }
}

function computeWorkloadScale(placed: PlacedBlock[]): WorkloadScale {
  let maxRowsRead = 0
  let maxRowsWritten = 0
  let maxQueryCount = 0
  let maxFootprint = 0
  for (const b of placed) {
    const footprint = tableFootprint(b.node)
    if (footprint > maxFootprint) maxFootprint = footprint
    const a = b.node.activity
    if (!a) continue
    if (a.rowsRead > maxRowsRead) maxRowsRead = a.rowsRead
    if (a.rowsWritten > maxRowsWritten) maxRowsWritten = a.rowsWritten
    if (a.queryCount > maxQueryCount) maxQueryCount = a.queryCount
  }
  return { maxRowsRead, maxRowsWritten, maxQueryCount, maxFootprint }
}

function workloadForNode(node: TableNode, scale: WorkloadScale): WorkloadVisual {
  const a = node.activity
  const structuralIntensity = logIntensity(tableFootprint(node), scale.maxFootprint)
  if (!a) {
    return {
      readIntensity: 0,
      writeIntensity: 0,
      queryIntensity: 0,
      activityScore: 0,
      structuralIntensity,
      unavailable: node.workloadUnavailable ?? false,
    }
  }
  return {
    readIntensity: logIntensity(a.rowsRead, scale.maxRowsRead),
    writeIntensity: logIntensity(a.rowsWritten, scale.maxRowsWritten),
    queryIntensity: logIntensity(a.queryCount, scale.maxQueryCount),
    activityScore: a.activityScore,
    structuralIntensity,
    unavailable: false,
  }
}

function tableFootprint(node: TableNode): number {
  if (node.bytesOnDisk > 0) return node.bytesOnDisk
  // Match the renderer's rough row fallback: enough to order tables visually,
  // not enough to claim precise storage when bytes are unavailable.
  if (node.rows > 0) return node.rows * 100
  return 0
}

function logIntensity(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || value <= 0 || max <= 0) return 0
  return Math.max(0, Math.min(1, Math.log10(value + 1) / Math.log10(max + 1)))
}

function drawCuboid(
  ctx: CanvasRenderingContext2D,
  g: Geometry,
  top: RGB,
  state: {
    key: string
    nowMs: number
    activityScore: number
    workload: WorkloadVisual
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
  drawLeftFacadeWindows(ctx, g, state.key, state.nowMs, state.workload, state.hovered)

  // Right front face.
  ctx.beginPath()
  ctx.moveTo(sx + w, topY)
  ctx.lineTo(sx, topY + h)
  ctx.lineTo(sx, sy + h)
  ctx.lineTo(sx + w, sy)
  ctx.closePath()
  ctx.fillStyle = rgbToCss(right)
  ctx.fill()
  drawRightFacadeWindows(ctx, g, state.key, state.nowMs, state.workload, state.hovered)

  // Top face.
  traceRoundedDiamond(ctx, sx, topY, w, h, Math.min(w, h) * TOP_CORNER_RADIUS_RATIO)
  const lift = Math.min(0.24, glow * 0.2 + (state.hovered ? 0.14 : 0))
  const topGrad = ctx.createLinearGradient(sx - w * 0.6, topY - h, sx + w * 0.6, topY + h)
  topGrad.addColorStop(0, rgbToCss(mix(top, { r: 190, g: 210, b: 232 }, 0.14 + lift * 0.4)))
  topGrad.addColorStop(1, rgbToCss(shade(top, 0.72)))
  ctx.fillStyle = topGrad
  ctx.fill()
  drawRoofUnits(ctx, g, top, state.hovered, state.key, state.workload)

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
    const district = dbTintRgb(b.node.database)
    const lotFill = mix({ r: 8, g: 13, b: 24 }, district, 0.16)
    traceRoundedDiamond(ctx, sx, sy, w * 1.12, h * 1.12, h * 0.1)
    ctx.fillStyle = rgbToRgba(lotFill, 0.46)
    ctx.fill()
    traceRoundedDiamond(ctx, sx, sy, w * 1.12, h * 1.12, h * 0.1)
    ctx.lineWidth = 0.8
    ctx.strokeStyle = rgbToRgba(mix(district, { r: 160, g: 210, b: 255 }, 0.22), 0.22)
    ctx.stroke()

    const stripe = stableUnit(`${tableKey(b.node)}:lot-stripe`)
    if (stripe > 0.46) {
      ctx.beginPath()
      ctx.moveTo(sx - w * 0.72, sy + h * 0.2)
      ctx.lineTo(sx - w * 0.18, sy + h * 0.47)
      ctx.lineWidth = 1.1
      ctx.strokeStyle =
        stripe > 0.74 ? 'rgba(245, 70, 224, 0.34)' : 'rgba(75, 228, 255, 0.28)'
      ctx.stroke()
    }
  }
}

function drawLeftFacadeWindows(
  ctx: CanvasRenderingContext2D,
  g: Geometry,
  key: string,
  nowMs: number,
  workload: WorkloadVisual,
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
      ctx.fillStyle = workloadWindowColor({
        key,
        row,
        col,
        side: 'read',
        metricIntensity: workload.readIntensity,
        queryIntensity: workload.queryIntensity,
        structuralIntensity: workload.structuralIntensity,
        unavailable: workload.unavailable,
        nowMs,
        hovered,
      })
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
  nowMs: number,
  workload: WorkloadVisual,
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
      ctx.fillStyle = workloadWindowColor({
        key,
        row,
        col,
        side: 'write',
        metricIntensity: workload.writeIntensity,
        queryIntensity: workload.queryIntensity,
        structuralIntensity: workload.structuralIntensity,
        unavailable: workload.unavailable,
        nowMs,
        hovered,
      })
      ctx.fillRect(x - winW * 0.5, y - winH * 0.5, winW, winH)
      col++
    }
    row++
  }
  ctx.restore()
}

function workloadWindowColor({
  key,
  row,
  col,
  side,
  metricIntensity,
  queryIntensity,
  structuralIntensity,
  unavailable,
  nowMs,
  hovered,
}: {
  key: string
  row: number
  col: number
  side: 'read' | 'write'
  metricIntensity: number
  queryIntensity: number
  structuralIntensity: number
  unavailable: boolean
  nowMs: number
  hovered: boolean
}): string {
  const seed = `${key}:${side}:${row}:${col}`
  if (unavailable) {
    const density = Math.min(0.78, 0.16 + structuralIntensity * 0.48)
    const lit = stableUnit(seed) < density
    if (!lit) return side === 'read' ? 'rgba(13, 23, 31, 0.66)' : 'rgba(14, 20, 28, 0.66)'
    const flickerSeed = stableUnit(`${seed}:structural-flicker`) * Math.PI * 2
    const flicker = 0.92 + 0.08 * Math.sin(nowMs * 0.0022 + flickerSeed)
    const alpha = Math.min(0.56, (0.18 + structuralIntensity * 0.22 + (hovered ? 0.1 : 0)) * flicker)
    return side === 'read'
      ? `rgba(133, 169, 188, ${alpha})`
      : `rgba(104, 129, 146, ${alpha})`
  }

  const density = Math.min(0.96, 0.06 + metricIntensity * 0.72 + queryIntensity * 0.18)
  const lit = metricIntensity > 0.015 && stableUnit(seed) < density
  if (!lit) {
    if (!hovered) return side === 'read' ? 'rgba(12, 23, 34, 0.64)' : 'rgba(18, 17, 30, 0.62)'
    return side === 'read' ? 'rgba(86, 190, 216, 0.28)' : 'rgba(196, 88, 183, 0.25)'
  }

  const flickerSeed = stableUnit(`${seed}:flicker`) * Math.PI * 2
  const flicker = 0.86 + 0.14 * Math.sin(nowMs * 0.006 + flickerSeed)
  const alpha = Math.min(
    0.9,
    (0.24 + metricIntensity * 0.46 + queryIntensity * 0.24 + (hovered ? 0.12 : 0)) * flicker,
  )
  return side === 'read'
    ? `rgba(83, 229, 255, ${alpha})`
    : `rgba(255, 77, 218, ${alpha})`
}

function drawRoofUnits(
  ctx: CanvasRenderingContext2D,
  g: Geometry,
  top: RGB,
  hovered: boolean,
  key: string,
  workload: WorkloadVisual,
): void {
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

  const dominantIntensity = Math.max(workload.readIntensity, workload.writeIntensity)
  if (workload.unavailable && workload.structuralIntensity > 0.05) {
    const alpha = Math.min(0.48, 0.18 + workload.structuralIntensity * 0.24)
    ctx.beginPath()
    ctx.moveTo(sx - w * 0.46, topY + h * 0.08)
    ctx.lineTo(sx + w * 0.22, topY - h * 0.18)
    ctx.lineWidth = 1
    ctx.strokeStyle = `rgba(135, 165, 181, ${alpha})`
    ctx.stroke()
  } else if (dominantIntensity > 0.05) {
    const alpha = Math.min(0.75, 0.26 + dominantIntensity * 0.42 + workload.queryIntensity * 0.12)
    const accent =
      workload.writeIntensity > workload.readIntensity
        ? `rgba(255, 69, 218, ${alpha})`
        : `rgba(69, 229, 255, ${alpha})`
    ctx.beginPath()
    ctx.moveTo(sx - w * 0.46, topY + h * 0.08)
    ctx.lineTo(sx + w * 0.22, topY - h * 0.18)
    ctx.lineWidth = 1
    ctx.strokeStyle = accent
    ctx.stroke()
  }

  if (stableUnit(`${key}:antenna`) > 0.72) {
    const ax = sx + w * (stableUnit(`${key}:antenna-x`) * 0.42 - 0.12)
    const ay = topY - h * (0.05 + stableUnit(`${key}:antenna-y`) * 0.28)
    ctx.beginPath()
    ctx.moveTo(ax, ay)
    ctx.lineTo(ax, ay - h * 0.34)
    ctx.lineWidth = 0.9
    ctx.strokeStyle = 'rgba(205, 223, 255, 0.58)'
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(ax, ay - h * 0.36, 1.4, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255, 90, 90, 0.82)'
    ctx.fill()
  }
}

function neonAccent(seed: string): RGB {
  const unit = stableUnit(seed)
  // Neon band between cyan and magenta.
  const hue = 0.52 + unit * 0.26
  return hslToRgb(hue % 1, 0.82, 0.62)
}

function drawAtmosphere(ctx: CanvasRenderingContext2D, nowMs: number, bounds: SceneBounds): void {
  const { cw, ch } = canvasCssSize(ctx)
  const cityGlowX = Number.isFinite(bounds.centerX) ? bounds.centerX : cw * 0.62
  const cityGlowY = Number.isFinite(bounds.centerY) ? bounds.centerY : ch * 0.52

  const fog = ctx.createRadialGradient(
    cityGlowX + bounds.width * 0.18,
    cityGlowY - bounds.height * 0.22,
    Math.max(16, bounds.height * 0.08),
    cityGlowX,
    cityGlowY,
    Math.max(cw, ch) * 0.78,
  )
  fog.addColorStop(0, 'rgba(24, 57, 76, 0.26)')
  fog.addColorStop(0.45, 'rgba(9, 24, 39, 0.22)')
  fog.addColorStop(1, 'rgba(2, 6, 12, 0.68)')
  ctx.fillStyle = fog
  ctx.fillRect(0, 0, cw, ch)

  const horizon = ctx.createLinearGradient(0, 0, 0, ch)
  horizon.addColorStop(0, 'rgba(5, 13, 24, 0.2)')
  horizon.addColorStop(0.5, 'rgba(7, 15, 24, 0.08)')
  horizon.addColorStop(1, 'rgba(1, 5, 9, 0.58)')
  ctx.fillStyle = horizon
  ctx.fillRect(0, 0, cw, ch)

  drawFarHaze(ctx, bounds, nowMs)

  // Sparse rain streaks for cyberpunk atmosphere.
  ctx.save()
  ctx.strokeStyle = 'rgba(170, 208, 255, 0.08)'
  ctx.lineWidth = 1
  const drift = nowMs * 0.015
  for (let i = 0; i < 86; i++) {
    const x = ((i * 97.13 + drift * 1.7) % (cw + 80)) - 40
    const y = ((i * 53.79 + drift * 2.6) % (ch + 120)) - 60
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x - 6, y + 16)
    ctx.stroke()
  }
  ctx.restore()
}

function canvasCssSize(ctx: CanvasRenderingContext2D): { cw: number; ch: number } {
  const transform = ctx.getTransform()
  const scaleX = transform.a || 1
  const scaleY = transform.d || 1
  return {
    cw: ctx.canvas.width / scaleX,
    ch: ctx.canvas.height / scaleY,
  }
}

function drawFarHaze(
  ctx: CanvasRenderingContext2D,
  bounds: SceneBounds,
  nowMs: number,
): void {
  const { cw, ch } = canvasCssSize(ctx)
  const baseY = Math.max(ch * 0.25, bounds.minY + bounds.height * 0.28)
  ctx.save()
  ctx.globalCompositeOperation = 'screen'
  for (let i = 0; i < 7; i++) {
    const unit = stableUnit(`haze:${i}`)
    const x = (unit * 1.4 - 0.2) * cw + Math.sin(nowMs * 0.00008 + i) * 10
    const y = baseY + i * 26
    const w = cw * (0.18 + stableUnit(`haze:w:${i}`) * 0.22)
    const grad = ctx.createRadialGradient(x, y, 4, x, y, w)
    grad.addColorStop(0, i % 2 === 0 ? 'rgba(67, 213, 255, 0.08)' : 'rgba(88, 177, 196, 0.065)')
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)')
    ctx.fillStyle = grad
    ctx.fillRect(x - w, y - 48, w * 2, 96)
  }
  ctx.restore()
}

function drawCityPlane(
  ctx: CanvasRenderingContext2D,
  placed: PlacedBlock[],
  view: View,
  bounds: SceneBounds,
  nowMs: number,
): void {
  if (placed.length === 0) return

  const minGx = Math.floor(Math.min(...placed.map((b) => b.gx))) - 1
  const maxGx = Math.ceil(Math.max(...placed.map((b) => b.gx))) + 2
  const minGy = Math.floor(Math.min(...placed.map((b) => b.gy))) - 1
  const maxGy = Math.ceil(Math.max(...placed.map((b) => b.gy))) + 2
  const corners = [
    projectGrid(minGx, minGy, view),
    projectGrid(maxGx, minGy, view),
    projectGrid(maxGx, maxGy, view),
    projectGrid(minGx, maxGy, view),
  ]

  ctx.save()
  const floorGlow = ctx.createRadialGradient(
    bounds.centerX,
    bounds.maxY - bounds.height * 0.2,
    10,
    bounds.centerX,
    bounds.maxY,
    Math.max(bounds.width, bounds.height) * 0.82,
  )
  floorGlow.addColorStop(0, 'rgba(54, 229, 255, 0.12)')
  floorGlow.addColorStop(0.38, 'rgba(56, 126, 150, 0.08)')
  floorGlow.addColorStop(1, 'rgba(0, 0, 0, 0)')
  ctx.fillStyle = floorGlow
  ctx.fillRect(bounds.minX - bounds.width * 0.35, bounds.minY, bounds.width * 1.7, bounds.height * 1.25)

  ctx.beginPath()
  corners.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y)
    else ctx.lineTo(p.x, p.y)
  })
  ctx.closePath()
  const slab = ctx.createLinearGradient(0, bounds.minY, 0, bounds.maxY)
  slab.addColorStop(0, 'rgba(14, 27, 39, 0.2)')
  slab.addColorStop(1, 'rgba(4, 10, 16, 0.3)')
  ctx.fillStyle = slab
  ctx.fill()
  ctx.strokeStyle = 'rgba(93, 139, 190, 0.18)'
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.clip()
  drawStreetGrid(ctx, minGx, maxGx, minGy, maxGy, view, nowMs)
  drawWetGroundSheen(ctx, bounds, nowMs)
  ctx.restore()
}

function drawStreetGrid(
  ctx: CanvasRenderingContext2D,
  minGx: number,
  maxGx: number,
  minGy: number,
  maxGy: number,
  view: View,
  nowMs: number,
): void {
  ctx.save()
  ctx.lineCap = 'round'
  for (let gx = minGx; gx <= maxGx; gx++) {
    const p1 = projectGrid(gx, minGy, view)
    const p2 = projectGrid(gx, maxGy, view)
    const major = gx % 4 === 0
    const shimmer = 0.02 * Math.sin(nowMs * 0.001 + gx)
    ctx.beginPath()
    ctx.moveTo(p1.x, p1.y)
    ctx.lineTo(p2.x, p2.y)
    ctx.lineWidth = major ? 1.35 : 0.7
    ctx.strokeStyle = major
      ? `rgba(66, 220, 255, ${0.16 + shimmer})`
      : 'rgba(84, 118, 166, 0.08)'
    ctx.stroke()
  }
  for (let gy = minGy; gy <= maxGy; gy++) {
    const p1 = projectGrid(minGx, gy, view)
    const p2 = projectGrid(maxGx, gy, view)
    const major = gy % 5 === 0
    const shimmer = 0.02 * Math.cos(nowMs * 0.001 + gy)
    ctx.beginPath()
    ctx.moveTo(p1.x, p1.y)
    ctx.lineTo(p2.x, p2.y)
    ctx.lineWidth = major ? 1.25 : 0.7
    ctx.strokeStyle = major
      ? `rgba(92, 176, 188, ${0.11 + shimmer})`
      : 'rgba(78, 117, 143, 0.07)'
    ctx.stroke()
  }
  ctx.restore()
}

function drawWetGroundSheen(
  ctx: CanvasRenderingContext2D,
  bounds: SceneBounds,
  nowMs: number,
): void {
  ctx.save()
  ctx.globalCompositeOperation = 'screen'
  for (let i = 0; i < 44; i++) {
    const x = bounds.minX + stableUnit(`sheen:x:${i}`) * bounds.width
    const y = bounds.minY + bounds.height * (0.24 + stableUnit(`sheen:y:${i}`) * 0.72)
    const len = 14 + stableUnit(`sheen:l:${i}`) * 42
    const alpha = 0.045 + stableUnit(`sheen:a:${i}`) * 0.055
    const phase = 0.75 + Math.sin(nowMs * 0.0014 + i) * 0.25
    ctx.beginPath()
    ctx.moveTo(x - len * 0.5, y)
    ctx.lineTo(x + len * 0.5, y - len * 0.18)
    ctx.lineWidth = 0.8
    ctx.strokeStyle =
      i % 3 === 0
        ? `rgba(126, 207, 201, ${alpha * phase})`
        : `rgba(90, 224, 255, ${alpha * phase})`
    ctx.stroke()
  }
  ctx.restore()
}

function projectGrid(gx: number, gy: number, view: View): { x: number; y: number } {
  return {
    x: view.offsetX + (gx - gy) * TILE_W * GRID_SPACING * view.scale,
    y: view.offsetY + (gx + gy) * TILE_H * GRID_SPACING * view.scale,
  }
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
  const focusKey = opts.selectedKey ?? opts.hoveredKey
  for (const b of placed) {
    const fromKey = tableKey(b.node)
    const from = geomByKey.get(fromKey)
    if (!from) continue
    for (const dep of b.node.dependencies) {
      const to = geomByKey.get(dep)
      if (!to) continue
      const focusedEdge =
        focusKey !== null && (fromKey === focusKey || dep === focusKey)

      const highlight =
        fromKey === opts.selectedKey ||
        dep === opts.selectedKey ||
        fromKey === opts.hoveredKey ||
        dep === opts.hoveredKey
      // Route edges between lifted anchor points above rooftops. This keeps the
      // endpoints visually unambiguous when lines pass near foreground buildings.
      const fromLift = Math.max(12, from.h * 0.75)
      const toLift = Math.max(12, to.h * 0.75)
      const startX = from.topX
      const startY = from.topY - fromLift
      const endX = to.topX
      const endY = to.topY - toLift
      const midX = (startX + endX) / 2
      const midY = (startY + endY) / 2 - 24 * Math.min(1, view0Scale(from, to))
      const edgeSeed = `${fromKey}->${dep}`
      const accent = neonAccent(edgeSeed)
      const base = highlight ? 'rgba(255, 243, 107, 0.95)' : rgbToCss(accent)

      // Vertical stems make it explicit which rooftops own the edge.
      ctx.beginPath()
      ctx.moveTo(from.topX, from.topY)
      ctx.lineTo(startX, startY)
      ctx.moveTo(to.topX, to.topY)
      ctx.lineTo(endX, endY)
      if (layer === 'under') {
        if (focusKey && !focusedEdge) {
          ctx.lineWidth = 1.2
          ctx.strokeStyle = 'rgba(120, 184, 224, 0.08)'
        } else {
          ctx.lineWidth = highlight ? 2 : 1.4
          ctx.strokeStyle = highlight ? 'rgba(255, 244, 164, 0.32)' : 'rgba(121, 227, 255, 0.14)'
        }
      } else {
        ctx.lineWidth = highlight ? 2.2 : 1.5
        ctx.strokeStyle = highlight ? 'rgba(255, 245, 148, 0.9)' : 'rgba(191, 236, 255, 0.74)'
      }
      ctx.stroke()

      ctx.beginPath()
      ctx.moveTo(startX, startY)
      ctx.quadraticCurveTo(midX, midY, endX, endY)
      if (layer === 'under') {
        if (focusKey && !focusedEdge) {
          ctx.lineWidth = 2.8
          ctx.strokeStyle = 'rgba(120, 184, 224, 0.07)'
        } else {
          ctx.lineWidth = highlight ? 6.2 : 4.2
          ctx.strokeStyle = highlight
            ? 'rgba(255, 244, 164, 0.24)'
            : 'rgba(121, 227, 255, 0.12)'
        }
        ctx.stroke()
      } else {
        if (focusedEdge) {
          ctx.save()
          ctx.shadowBlur = highlight ? 18 : 11
          ctx.shadowColor = highlight
            ? 'rgba(255, 242, 122, 0.9)'
            : `${base.replace('rgb(', 'rgba(').replace(')', ', 0.78)')}`
          ctx.lineWidth = highlight ? 2.8 : 2.05
          ctx.strokeStyle = highlight ? '#fff36b' : base
          ctx.stroke()
          ctx.restore()

          ctx.beginPath()
          ctx.moveTo(startX, startY)
          ctx.quadraticCurveTo(midX, midY, endX, endY)
          ctx.lineWidth = 0.95
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.42)'
          ctx.stroke()
        } else {
          // Keep unfocused live edges visible above dense skylines, but subtle.
          ctx.lineWidth = 1.15
          ctx.strokeStyle = 'rgba(168, 214, 242, 0.28)'
          ctx.stroke()
        }
      }

      if (layer === 'over') {
        if (focusedEdge) {
          // Animated "data packet" markers make direction and connectivity readable.
          const t = (opts.nowMs * 0.00022 + stableUnit(edgeSeed)) % 1
          const t2 = (t + 0.52) % 1
          const p1 = quadPoint(startX, startY, midX, midY, endX, endY, t)
          const p2 = quadPoint(startX, startY, midX, midY, endX, endY, t2)
          const packetR = highlight ? 3 : 2.2
          ctx.beginPath()
          ctx.arc(p1.x, p1.y, packetR, 0, Math.PI * 2)
          ctx.fillStyle = highlight ? '#fff8ab' : 'rgba(207, 248, 255, 0.86)'
          ctx.fill()
          ctx.beginPath()
          ctx.arc(p2.x, p2.y, packetR * 0.82, 0, Math.PI * 2)
          ctx.fillStyle = highlight ? 'rgba(255, 241, 163, 0.9)' : 'rgba(182, 238, 255, 0.72)'
          ctx.fill()

          // Marker at the dependency end + tiny arrowhead for direction.
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
      } else {
        // Keep subtle directional hint visible even without hover/selection.
        const head = quadPoint(startX, startY, midX, midY, endX, endY, 0.965)
        const vx = endX - head.x
        const vy = endY - head.y
        const len = Math.hypot(vx, vy) || 1
        const ux = vx / len
        const uy = vy / len
        const px = -uy
        const py = ux
        const arrowLen = highlight ? 8 : 6
        const arrowW = highlight ? 4.4 : 3.4
        const bx = endX - ux * arrowLen
        const by = endY - uy * arrowLen
        ctx.beginPath()
        ctx.moveTo(endX, endY)
        ctx.lineTo(bx + px * arrowW, by + py * arrowW)
        ctx.lineTo(bx - px * arrowW, by - py * arrowW)
        ctx.closePath()
        ctx.fillStyle = highlight ? 'rgba(255, 244, 150, 0.45)' : 'rgba(171, 221, 247, 0.2)'
        ctx.fill()
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
