export type CueStatus = 'draft' | 'reviewed' | 'issue'
export type Locale = 'zh-CN' | 'en-US' | 'ja-JP'

/** 配音棚归属字段：只有配音棚回传/挂起确认流程可以写入，工作台永不覆盖 */
export interface StudioTake {
  recordedStart: number
  recordedDuration: number
  standIn: string
  note: string
  updatedAt: number
  batchId: string
}

export interface Cue {
  id: string
  start: number
  end: number
  source: string
  target: string
  actorId: string
  speed: number
  termIds: string[]
  status: CueStatus
  locked: boolean
  /** 配音棚回传的实录信息，与工作台字段互不覆盖 */
  studio?: StudioTake
}

export interface Actor {
  id: string
  name: string
  color: string
  localeHint: string
}

export interface Term {
  id: string
  source: string
  target: string
  note: string
}

export interface Snapshot {
  id: string
  name: string
  createdAt: number
  cues: Cue[]
}

/** 配音棚回传单条记录（解析后的最小载荷） */
export interface StudioRecord {
  start: number
  duration: number
  standIn: string
  note: string
}

export type PendingReason = 'missing' | 'extra' | 'shifted'

/** 对账后无法自动归属的实录，挂起等人定归属 */
export interface PendingTake {
  id: string
  key: string
  reason: PendingReason
  start: number
  end?: number
  duration?: number
  standIn?: string
  note?: string
  /** shifted / extra 时疑似对应的台词，可改选 */
  suggestionCueId?: string
  /** missing 时对应的工作台台词 */
  cueId?: string
  batchId: string
  createdAt: number
}

export type StudioBatchStatus = 'applied' | 'failed'

/** 一次配音棚回传；失败时保留在批次队列里，从配音棚侧重试 */
export interface StudioBatch {
  id: string
  name: string
  createdAt: number
  appliedAt?: number
  records: StudioRecord[]
  status: StudioBatchStatus
  error?: string
}

export interface StudioState {
  batches: StudioBatch[]
  pending: PendingTake[]
  /** 已人工忽略的挂起项指纹，避免重复挂起 */
  dismissed: string[]
}

export const SCHEMA_VERSION = 2

export interface EditorDocument {
  id: string
  title: string
  language: Locale
  schemaVersion: number
  cues: Cue[]
  actors: Actor[]
  terms: Term[]
  snapshots: Snapshot[]
  studio: StudioState
  updatedAt: number
  revision: number
  lastWriter: string
}

/** 字段归属：这些字段归工作台；cue.studio 归配音棚 */
export const WORKBENCH_CUE_FIELDS = [
  'start', 'end', 'source', 'target', 'actorId', 'speed', 'termIds', 'status', 'locked',
] as const

export type WorkbenchCueField = (typeof WORKBENCH_CUE_FIELDS)[number]

/** 多标签三方合并后仍无法自动消解的同字段分歧，挂起由人工选择归属 */
export interface FieldConflict {
  cueId: string
  /** 工作台字段名，或 '__cue__' 表示一方删除、另一方修改了整条台词 */
  field: WorkbenchCueField | '__cue__'
  base: unknown
  local: unknown
  remote: unknown
}

export interface CueConflict {
  cueId: string
  type: 'actor' | 'tone' | 'address'
  message: string
}

export interface HistoryEntry {
  label: string
  cues: Cue[]
  selectedCueId: string | null
}
