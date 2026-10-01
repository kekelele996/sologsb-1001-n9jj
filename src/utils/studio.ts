import type { Cue, StudioRecording, StudioReturn, StudioReturnItem } from '../types'
import { makeId } from './id'

// 精确匹配容差（秒）：时间码偏差在此范围内视为同一条
export const EXACT_TOLERANCE = 0.08
// 错位匹配容差（秒）：超出精确范围但仍可推断归属，挂起等人定
export const NEAR_TOLERANCE = 0.6

const num = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.trim().replace(',', '.'))
    if (Number.isFinite(parsed)) return parsed
  }
  return NaN
}

/**
 * 解析配音棚回传文件。
 * 支持裸数组或 { recordings | cues | entries | items: [...] }，
 * 字段名兼容 timecode/start/tc、actualDuration/duration/actual、dubActor/actor/voice。
 */
export const parseStudioReturn = (text: string): StudioRecording[] => {
  const data = JSON.parse(text) as unknown
  const rawList = Array.isArray(data)
    ? data
    : (data as Record<string, unknown> | null)?.recordings
      ?? (data as Record<string, unknown> | null)?.cues
      ?? (data as Record<string, unknown> | null)?.entries
      ?? (data as Record<string, unknown> | null)?.items
  if (!Array.isArray(rawList)) throw new Error('BAD_STUDIO_RETURN')
  return rawList.map((item) => {
    if (typeof item !== 'object' || item === null) throw new Error('BAD_STUDIO_RETURN')
    const record = item as Record<string, unknown>
    const timecode = num(record.timecode ?? record.start ?? record.tc ?? record.from)
    const actualDuration = num(record.actualDuration ?? record.duration ?? record.actual ?? record.dur)
    if (!Number.isFinite(timecode) || !Number.isFinite(actualDuration)) throw new Error('BAD_STUDIO_RETURN')
    const dubActorName = record.dubActor ?? record.actor ?? record.voice ?? record.dubActorName
    return {
      timecode,
      actualDuration,
      dubActorName: dubActorName != null && dubActorName !== '' ? String(dubActorName) : undefined,
    }
  })
}

/**
 * 按时间码把回传录音匹配到台词。
 * - 精确匹配 → matched（自动应用）
 * - 仅一条接近 → misaligned（挂起，建议归属）
 * - 多条接近 → misaligned（挂起，不指定建议）
 * - 没有接近 → extra（挂起）
 * - 没有任何录音覆盖的台词 → missing（挂起）
 */
export const reconcileRecordings = (cues: Cue[], recordings: StudioRecording[]): StudioReturnItem[] => {
  const items: StudioReturnItem[] = []
  const usedCueIds = new Set<string>()
  const usedRecordingIndexes = new Set<number>()

  // 1. 精确匹配
  recordings.forEach((recording, index) => {
    const exact = cues.find((cue) => !usedCueIds.has(cue.id) && Math.abs(cue.start - recording.timecode) <= EXACT_TOLERANCE)
    if (!exact) return
    usedCueIds.add(exact.id)
    usedRecordingIndexes.add(index)
    items.push({
      id: makeId('sri'),
      kind: 'matched',
      status: 'applied',
      timecode: recording.timecode,
      actualDuration: recording.actualDuration,
      dubActorName: recording.dubActorName,
      cueId: exact.id,
    })
  })

  // 2. 错位 / 多出
  recordings.forEach((recording, index) => {
    if (usedRecordingIndexes.has(index)) return
    const candidates = cues
      .filter((cue) => !usedCueIds.has(cue.id))
      .map((cue) => ({ cue, delta: Math.abs(cue.start - recording.timecode) }))
      .filter((entry) => entry.delta <= NEAR_TOLERANCE)
      .sort((a, b) => a.delta - b.delta)
    if (candidates.length === 1) {
      const { cue, delta } = candidates[0]
      usedCueIds.add(cue.id)
      items.push({
        id: makeId('sri'),
        kind: 'misaligned',
        status: 'pending',
        timecode: recording.timecode,
        actualDuration: recording.actualDuration,
        dubActorName: recording.dubActorName,
        suggestedCueId: cue.id,
        reason: `时间码偏差 ${delta.toFixed(2)}s`,
      })
    } else if (candidates.length > 1) {
      items.push({
        id: makeId('sri'),
        kind: 'misaligned',
        status: 'pending',
        timecode: recording.timecode,
        actualDuration: recording.actualDuration,
        dubActorName: recording.dubActorName,
        reason: `时间码接近 ${candidates.length} 条台词，无法确定归属`,
      })
    } else {
      items.push({
        id: makeId('sri'),
        kind: 'extra',
        status: 'pending',
        timecode: recording.timecode,
        actualDuration: recording.actualDuration,
        dubActorName: recording.dubActorName,
        reason: '没有匹配的台词',
      })
    }
  })

  // 3. 缺少：没有被任何录音覆盖的台词
  cues.forEach((cue) => {
    if (usedCueIds.has(cue.id)) return
    items.push({
      id: makeId('sri'),
      kind: 'missing',
      status: 'pending',
      missingCueId: cue.id,
      reason: '配音棚未回传该台词',
    })
  })

  return items
}

/** 把一条回传条目的配音棚字段写到台词上（只碰配音棚所有字段） */
export const applyStudioFields = (cue: Cue, item: StudioReturnItem): void => {
  if (item.actualDuration != null) cue.actualDuration = item.actualDuration
  if (item.dubActorName != null) cue.dubActorName = item.dubActorName
}

/**
 * 模拟配音棚回传：从当前台词生成一批录音，
 * 混入精确、错位、多出和缺少，便于演示挂起流程。
 */
export const simulateRecordings = (cues: Cue[], actorNames: string[]): StudioRecording[] => {
  const recordings: StudioRecording[] = []
  cues.forEach((cue, index) => {
    // 约 15% 概率漏掉这条（missing）
    if (index % 7 === 6) return
    const misaligned = index % 5 === 4
    const shift = misaligned ? (index % 2 === 0 ? 0.32 : -0.28) : 0
    const base = Math.max(0.4, cue.end - cue.start)
    const variance = 0.88 + ((index * 37) % 15) / 100 // 0.88 ~ 1.02
    const isStandIn = index % 4 === 3
    const dubActorName = isStandIn
      ? (actorNames[(index + 1) % Math.max(1, actorNames.length)] ?? '替班演员')
      : undefined
    recordings.push({
      timecode: Number((cue.start + shift).toFixed(2)),
      actualDuration: Number((base * variance).toFixed(2)),
      dubActorName,
    })
  })
  // 额外多出的录音（时间码对不上任何台词）
  recordings.push({ timecode: 999.9, actualDuration: 3.2, dubActorName: actorNames[0] ?? '旁白' })
  recordings.push({ timecode: 1024.5, actualDuration: 2.6 })
  return recordings
}

/** 旧稿升级：补齐配音棚回传功能引入的字段 */
export const migrateDocument = <T extends { cues: Cue[]; studioReturns?: StudioReturn[] }>(document: T): T => {
  document.cues.forEach((cue) => {
    if (cue.actualDuration === undefined) cue.actualDuration = undefined
    if (cue.dubActorName === undefined) cue.dubActorName = undefined
  })
  if (!Array.isArray(document.studioReturns)) document.studioReturns = []
  return document
}
