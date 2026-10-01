export type CueStatus = 'draft' | 'reviewed' | 'issue'
export type Locale = 'zh-CN' | 'en-US' | 'ja-JP'

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
  // —— 以下字段归配音棚所有，工作台只读 ——
  actualDuration?: number
  dubActorName?: string
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

// 配音棚回传：单条录音（配音棚侧数据）
export interface StudioRecording {
  timecode: number
  actualDuration: number
  dubActorName?: string
}

export type StudioReturnKind = 'matched' | 'misaligned' | 'extra' | 'missing'
export type StudioReturnItemStatus = 'applied' | 'pending' | 'assigned' | 'discarded' | 'ignored'

export interface StudioReturnItem {
  id: string
  kind: StudioReturnKind
  status: StudioReturnItemStatus
  // 录音数据（matched / misaligned / extra）
  timecode?: number
  actualDuration?: number
  dubActorName?: string
  // 关联台词
  cueId?: string          // matched 直接应用；assigned 人工指派
  suggestedCueId?: string // misaligned 建议的台词
  missingCueId?: string   // missing：哪条台词缺回传
  reason?: string
}

export interface StudioReturn {
  id: string
  importedAt: number
  source: string            // 文件名，或 'simulated' / 'manual'
  rawText?: string          // 原始文本，解析失败时用于重试
  recordings: StudioRecording[]
  parseFailed: boolean
  items: StudioReturnItem[]
}

export interface EditorDocument {
  id: string
  title: string
  language: Locale
  cues: Cue[]
  actors: Actor[]
  terms: Term[]
  snapshots: Snapshot[]
  studioReturns: StudioReturn[]
  updatedAt: number
  revision: number
  lastWriter: string
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
