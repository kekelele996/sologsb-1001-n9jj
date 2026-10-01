import type { Cue, PendingReason, PendingTake, StudioRecord } from '../types'
import { makeId } from './id'
import { parseTime } from './subtitle'

/** 时间码匹配容差（秒）：实录起点落在台词时间码 ±容差内视为同一条 */
export const TIMECODE_TOLERANCE = 0.6

export interface ReconcileResult {
  /** 按 cueId 索引的可自动应用实录 */
  matched: Map<string, { record: StudioRecord; cueId: string }>
  pending: PendingTake[]
}

/**
 * 回传格式（每行一条，#开头为注释，字段用 | 或制表符分隔）：
 * 00:00:00,000 | 4.2 | 替班演员 | 备注
 * 时间码 | 实录时长(秒) | 替班（可空） | 备注（可空）
 */
export const parseStudioReturn = (text: string): { record: StudioRecord; line: number }[] => {
  const lines = text.replace(/\r/g, '').split('\n')
  const rows: { record: StudioRecord; line: number }[] = []
  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const parts = line.split(/[|\t]/).map((part) => part.trim())
    const start = parseTime(parts[0] ?? '')
    const duration = Number(parts[1])
    if (!parts[0] || !Number.isFinite(duration) || duration <= 0) return
    rows.push({
      line: index + 1,
      record: { start: Number(start.toFixed(3)), duration: Number(duration.toFixed(3)), standIn: parts[2] ?? '', note: parts[3] ?? '' },
    })
  })
  return rows
}

const takeKey = (record: StudioRecord) => `${record.start.toFixed(3)}|${record.duration.toFixed(3)}`

const cueDistance = (cue: Cue, start: number) => Math.abs(cue.start - start)

/**
 * 回传按时间码对到台词：
 * - 唯一落在容差窗口内：自动匹配
 * - 窗口内有多条（错位）：挂起，给最接近的候选建议
 * - 窗口内没有（多出）：挂起等人指定归属
 * - 工作台有台词但本次无回传（缺少）：挂起一条 missing，等补录或确认
 */
export const reconcile = (cues: Cue[], records: StudioRecord[], batchId: string, dismissed: string[] = []): ReconcileResult => {
  const matched = new Map<string, { record: StudioRecord; cueId: string }>()
  const pending: PendingTake[] = []
  const usedCueIds = new Set<string>()

  for (const record of records) {
    const key = takeKey(record)
    if (dismissed.includes(key)) continue
    const within = cues
      .map((cue) => ({ cue, distance: cueDistance(cue, record.start) }))
      .filter((item) => item.distance <= TIMECODE_TOLERANCE)
      .sort((a, b) => a.distance - b.distance)

    if (within.length === 1) {
      matched.set(within[0].cue.id, { record, cueId: within[0].cue.id })
      usedCueIds.add(within[0].cue.id)
    } else if (within.length > 1) {
      const reason: PendingReason = 'shifted'
      pending.push({
        id: makeId('pending'), key, reason,
        start: record.start, duration: record.duration, end: Number((record.start + record.duration).toFixed(3)),
        standIn: record.standIn, note: record.note,
        suggestionCueId: within[0].cue.id, batchId, createdAt: Date.now(),
      })
    } else {
      // 找最近的一条作为错位候选建议（超出容差，默认挂起不自动归）
      const nearest = cues.length ? cues.map((cue) => ({ cue, distance: cueDistance(cue, record.start) })).sort((a, b) => a.distance - b.distance)[0] : undefined
      pending.push({
        id: makeId('pending'), key, reason: 'extra',
        start: record.start, duration: record.duration, end: Number((record.start + record.duration).toFixed(3)),
        standIn: record.standIn, note: record.note,
        suggestionCueId: nearest?.cue.id, batchId, createdAt: Date.now(),
      })
    }
  }

  // 缺少：本次回传没有覆盖到的台词
  for (const cue of cues) {
    if (usedCueIds.has(cue.id)) continue
    const missingKey = `missing:${cue.start.toFixed(3)}`
    if (dismissed.includes(missingKey)) continue
    pending.push({
      id: makeId('pending'), key: missingKey, reason: 'missing',
      start: cue.start, end: cue.end, cueId: cue.id, batchId, createdAt: Date.now(),
    })
  }

  return { matched, pending }
}
