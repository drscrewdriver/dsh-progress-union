/**
 * dsh-progress-union/anchor — 零依赖锚点契约，供其他插件 import。
 * 版本握手：consumer 读 ANCHOR_VERSION，与 service.version 相等才解析字段。
 */
export const ANCHOR_VERSION = 1

export const ANCHOR_ROUTES = {
  anchor: '/progress-union/anchor',
  snapshot: '/progress-union/snapshot',
  status: '/dsh-progress/status',
}

export const BOARD_STATUSES = ['todo', 'doing', 'done', 'blocked']

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 形状校验：新旧快照都能过（version/board/time 必备，不挑新增字段）。 */
export function isAnchor(v) {
  if (!isObject(v)) return false
  if (typeof v.version !== 'number' || typeof v.sessionId !== 'string') return false
  if (!isObject(v.board) || typeof v.board.enabled !== 'boolean' || !isObject(v.board.summary)) return false
  if (!isObject(v.time)) return false
  const s = v.board.summary
  return ['total', 'done', 'percent'].every((k) => typeof s[k] === 'number')
}

/** 单行摘要：45% 3/7 · ETA 6m · stale 12m（缺值段省略）。 */
export function anchorLine(anchor) {
  if (!isAnchor(anchor)) return ''
  const s = anchor.board.summary
  const bits = [`${s.percent}% ${s.done}/${s.total}`]
  const eta = Number(anchor.time && anchor.time.etaMin)
  if (Number.isFinite(eta) && eta > 0) bits.push(`ETA ${Math.round(eta)}m`)
  const stale = Number(anchor.time && anchor.time.staleMin)
  if (Number.isFinite(stale) && stale > 0) bits.push(`stale ${Math.round(stale)}m`)
  return bits.join(' · ')
}
