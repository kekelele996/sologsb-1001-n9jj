import { defineStore } from 'pinia'
import type { Cue, EditorDocument, FieldConflict, Locale, PendingTake, Snapshot, StudioRecord } from '../types'
import { loadDocument, mergeDocuments, saveDocument } from '../utils/db'
import { makeId } from '../utils/id'
import { parseScript, parseSrt, toSrt } from '../utils/subtitle'
import { parseStudioReturn, reconcile } from '../utils/studio'
import { translate, type MessageKey } from '../i18n'

const DOCUMENT_ID = 'subtitle-dubbing-document'
let saveTimer: ReturnType<typeof setTimeout> | undefined
let channel: BroadcastChannel | undefined

const cloneCues = (cues: Cue[]): Cue[] => JSON.parse(JSON.stringify(cues)) as Cue[]
const cloneDocument = (document: EditorDocument): EditorDocument => JSON.parse(JSON.stringify(document)) as EditorDocument

const emptyStudio = () => ({ batches: [], pending: [], dismissed: [] })

const createDefaultDocument = (): EditorDocument => ({
  id: DOCUMENT_ID,
  title: '纪录片《开源之路》中文配音',
  language: 'zh-CN',
  schemaVersion: 2,
  revision: 0,
  updatedAt: Date.now(),
  lastWriter: '',
  actors: [
    { id: 'actor-narrator', name: '旁白 / Narrator', color: '#2f6fed', localeHint: 'zh-CN' },
    { id: 'actor-lin', name: '林博士 / Dr. Lin', color: '#cf5a39', localeHint: 'zh-CN' },
    { id: 'actor-chen', name: '陈工 / Engineer Chen', color: '#14866d', localeHint: 'zh-CN' },
    { id: 'actor-host', name: '主持人 / Host', color: '#7d53b8', localeHint: 'zh-CN' },
  ],
  terms: [
    { id: 'term-01', source: 'open source', target: '开源', note: '产品语境' },
    { id: 'term-02', source: 'maintainer', target: '维护者', note: '不使用“管理者”' },
    { id: 'term-03', source: 'pull request', target: '拉取请求', note: '首次出现保留英文缩写 PR' },
    { id: 'term-04', source: 'community', target: '社区', note: '泛指开发者社区' },
  ],
  cues: [
    { id: 'cue-demo-01', start: 0, end: 4.2, source: '开源并不是一项孤立的技术，而是一种持续协作的方式。', target: '开源并不是一项孤立的技术，而是一种持续协作的方式。', actorId: 'actor-narrator', speed: 1.02, termIds: ['term-01'], status: 'reviewed', locked: true },
    { id: 'cue-demo-02', start: 4.3, end: 8.6, source: '今天，我们邀请林博士谈谈社区维护者每天面对的选择。', target: '今天，我们邀请林博士谈谈社区维护者每天面对的选择。', actorId: 'actor-host', speed: 1, termIds: ['term-04', 'term-02'], status: 'reviewed', locked: false },
    { id: 'cue-demo-03', start: 8.8, end: 13.5, source: '每个拉取请求背后，都有一段需要被理解的上下文。', target: '每个拉取请求背后，都有一段需要被理解的上下文。', actorId: 'actor-lin', speed: 0.96, termIds: ['term-03'], status: 'reviewed', locked: false },
    { id: 'cue-demo-04', start: 13.7, end: 18.8, source: '请您先介绍一次印象最深的代码评审。', target: '请您先介绍一次印象最深的代码评审。', actorId: 'actor-host', speed: 1.03, termIds: [], status: 'draft', locked: false },
    { id: 'cue-demo-05', start: 19, end: 25.1, source: '那次修改很小，却让新用户第一次能够顺利完成安装。', target: '那次修改很小，却让新用户第一次顺利完成安装。', actorId: 'actor-lin', speed: 0.98, termIds: [], status: 'issue', locked: false },
    { id: 'cue-demo-06', start: 25.4, end: 31.2, source: '所以我们决定把安装说明拆开，并为每个平台补上验证步骤。', target: '因此，我们拆分安装说明，并为每个平台补上验证步骤。', actorId: 'actor-chen', speed: 1.05, termIds: [], status: 'draft', locked: false },
  ],
  snapshots: [],
  studio: emptyStudio(),
})

type SaveState = 'saved' | 'dirty' | 'saving'

export const useEditorStore = defineStore('subtitle-editor', {
  state: () => ({
    document: createDefaultDocument(),
    /** 本标签最后一次同步到的库内版本，三方合并的共同祖先 */
    baseDocument: undefined as EditorDocument | undefined,
    selectedCueId: 'cue-demo-03' as string | null,
    actorFilter: 'all',
    timelineZoom: 1,
    saveState: 'saved' as SaveState,
    saving: false,
    initialized: false,
    /** 字段级合并后仍未消解、等人定归属的分歧 */
    fieldConflicts: [] as FieldConflict[],
    resolvedConflictKeys: [] as string[],
    online: navigator.onLine,
    studioOnline: true,
    tabId: makeId('tab'),
    mutationSerial: 0,
    past: [] as { label: string; cues: Cue[]; selectedCueId: string | null }[],
    future: [] as { label: string; cues: Cue[]; selectedCueId: string | null }[],
  }),
  getters: {
    t: (state) => (key: MessageKey, values?: Record<string, string | number>) => translate(state.document.language, key, values),
    selectedCue(state): Cue | undefined {
      return state.document.cues.find((cue) => cue.id === state.selectedCueId)
    },
    visibleCues(state): Cue[] {
      return state.actorFilter === 'all'
        ? state.document.cues
        : state.document.cues.filter((cue) => cue.actorId === state.actorFilter)
    },
    totalDuration(state): number {
      return Math.max(10, ...state.document.cues.map((cue) => cue.end)) * 1.04
    },
    pendingTakes(state): PendingTake[] {
      return state.document.studio.pending
    },
    failedBatches(state) {
      return state.document.studio.batches.filter((batch) => batch.status === 'failed')
    },
    activeConflicts(state): FieldConflict[] {
      return state.fieldConflicts.filter((conflict) => !state.resolvedConflictKeys.includes(conflictFingerprint(conflict)))
    },
    hasAttention(state): boolean {
      return state.document.studio.pending.length > 0
        || state.document.studio.batches.some((batch) => batch.status === 'failed')
        || state.fieldConflicts.some((conflict) => !state.resolvedConflictKeys.includes(conflictFingerprint(conflict)))
    },
  },
  actions: {
    async initialize() {
      if (this.initialized) return
      this.online = navigator.onLine
      const stored = await loadDocument(DOCUMENT_ID)
      if (stored) {
        this.document = stored
        this.baseDocument = cloneDocument(stored)
      } else {
        const { document } = await saveDocument(cloneDocument(this.document))
        this.document = document
        this.baseDocument = cloneDocument(document)
      }
      this.initialized = true
      if ('BroadcastChannel' in window) {
        channel = new BroadcastChannel('sologsb-1001-document')
        channel.onmessage = async (event) => {
          const message = event.data as { type: string; tabId: string; revision: number; documentId: string }
          if (message.type !== 'document-updated' || message.tabId === this.tabId || message.documentId !== DOCUMENT_ID) return
          if (message.revision <= (this.baseDocument?.revision ?? this.document.revision)) return
          await this.absorbRemote()
        }
      }
    },
    /** 拉取库内最新版并入本标签：工作台改动态中也不丢，字段级三方合并 */
    async absorbRemote() {
      const latest = await loadDocument(DOCUMENT_ID)
      if (!latest || latest.revision <= (this.baseDocument?.revision ?? 0)) return
      const merged = mergeDocuments(this.baseDocument, this.document, latest)
      this.document = merged.document
      this.baseDocument = cloneDocument(latest)
      if (merged.conflicts.length) this.fieldConflicts = [...this.fieldConflicts, ...merged.conflicts]
      this.document.revision = latest.revision
    },
    setOnline(value: boolean) {
      this.online = value
    },
    setStudioOnline(value: boolean) {
      this.studioOnline = value
      if (value) {
        const failed = this.document.studio.batches.find((batch) => batch.status === 'failed')
        if (failed) void this.retryBatch(failed.id)
      }
    },
    selectCue(id: string | null) {
      this.selectedCueId = id
    },
    setLocale(locale: Locale) {
      this.document.language = locale
      this.markChanged('language', true)
    },
    commit(label: string, mutate: (cues: Cue[]) => void, nextSelection?: string | null) {
      const before = cloneCues(this.document.cues)
      const working = cloneCues(this.document.cues)
      mutate(working)
      this.past.push({ label, cues: before, selectedCueId: this.selectedCueId })
      if (this.past.length > 60) this.past.shift()
      this.future = []
      this.document.cues = working
      if (nextSelection !== undefined) this.selectedCueId = nextSelection
      this.markChanged(label)
    },
    markChanged(label: string, persist = true) {
      this.document.updatedAt = Date.now()
      if (persist) {
        this.saveState = 'dirty'
        this.mutationSerial += 1
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => void this.persist(label), 500)
      }
    },
    async persist(label = 'autosave') {
      if (!this.initialized || this.saveState === 'saving') return
      const serial = this.mutationSerial
      this.saveState = 'saving'
      this.saving = true
      try {
        const outcome = await saveDocument(cloneDocument(this.document), this.baseDocument)
        this.document.revision = outcome.document.revision
        this.document.updatedAt = outcome.document.updatedAt
        // 合并可能带回其他标签的内容，直接采用落库结果
        this.document = outcome.document
        this.baseDocument = cloneDocument(outcome.document)
        if (outcome.conflicts.length) this.fieldConflicts = dedupeConflicts([...this.fieldConflicts, ...outcome.conflicts])
        if (serial === this.mutationSerial) this.saveState = 'saved'
        else this.saveState = 'dirty'
        channel?.postMessage({ type: 'document-updated', tabId: this.tabId, revision: outcome.document.revision, documentId: DOCUMENT_ID })
      } catch (error) {
        this.saveState = 'dirty'
        console.error(label, error)
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => void this.persist(label), 1200)
      } finally {
        this.saving = false
        if (this.saveState === 'dirty') {
          if (saveTimer) clearTimeout(saveTimer)
          saveTimer = setTimeout(() => void this.persist(label), 700)
        }
      }
    },
    undo() {
      const entry = this.past.pop()
      if (!entry) return
      this.future.push({ label: entry.label, cues: cloneCues(this.document.cues), selectedCueId: this.selectedCueId })
      this.document.cues = cloneCues(entry.cues)
      this.selectedCueId = entry.selectedCueId
      this.markChanged(`undo:${entry.label}`)
    },
    redo() {
      const entry = this.future.pop()
      if (!entry) return
      this.past.push({ label: entry.label, cues: cloneCues(this.document.cues), selectedCueId: this.selectedCueId })
      this.document.cues = cloneCues(entry.cues)
      this.selectedCueId = entry.selectedCueId
      this.markChanged(`redo:${entry.label}`)
    },
    updateCue(id: string, patch: Partial<Cue>, historyLabel = 'update-cue') {
      this.commit(historyLabel, (cues) => {
        const cue = cues.find((item) => item.id === id)
        if (!cue || cue.locked) return
        // 工作台编辑永远不碰配音棚域
        delete (patch as Partial<Cue>).studio
        Object.assign(cue, patch)
      })
    },
    markStatus(id: string, status: Cue['status']) {
      this.updateCue(id, { status }, `status:${status}`)
    },
    toggleLock(id: string) {
      this.updateCue(id, { locked: !this.document.cues.find((cue) => cue.id === id)?.locked }, 'toggle-lock')
    },
    splitCue(id: string) {
      const source = this.document.cues.find((cue) => cue.id === id)
      if (!source || source.locked) return
      const ratio = 0.5
      const middle = Number((source.start + (source.end - source.start) * ratio).toFixed(2))
      const sourceMid = Math.max(1, Math.round(source.source.length * ratio))
      const targetMid = Math.max(1, Math.round(source.target.length * ratio))
      const secondId = makeId('cue')
      this.commit('split', (cues) => {
        const index = cues.findIndex((cue) => cue.id === id)
        const cue = cues[index]
        const second: Cue = {
          ...cue,
          id: secondId,
          start: middle,
          source: cue.source.slice(sourceMid).trim(),
          target: cue.target.slice(targetMid).trim(),
          status: 'draft',
          locked: false,
          studio: undefined, // 拆分出的新台词尚无配音棚实录
        }
        cue.end = middle
        cue.source = cue.source.slice(0, sourceMid).trim()
        cue.target = cue.target.slice(0, targetMid).trim()
        cue.status = 'draft'
        cue.studio = undefined
        cues.splice(index + 1, 0, second)
      }, secondId)
    },
    mergeNext(id: string) {
      const index = this.document.cues.findIndex((cue) => cue.id === id)
      const current = this.document.cues[index]
      const next = this.document.cues[index + 1]
      if (!current || !next || current.locked || next.locked) return
      this.commit('merge', (cues) => {
        const item = cues[index]
        const following = cues[index + 1]
        item.end = following.end
        item.source = `${item.source} ${following.source}`.trim()
        item.target = `${item.target} ${following.target}`.trim()
        item.termIds = [...new Set([...item.termIds, ...following.termIds])]
        item.status = 'draft'
        // 合并后实录以起始台词为准，时长顺延到合并段结尾
        if (item.studio) item.studio = { ...item.studio, recordedDuration: Number(((following.studio?.recordedStart ?? following.start) + (following.studio?.recordedDuration ?? (following.end - following.start)) - item.studio.recordedStart).toFixed(3)) }
        else if (following.studio) item.studio = { ...following.studio, recordedStart: item.start }
        cues.splice(index + 1, 1)
      }, id)
    },
    moveCue(id: string, direction: -1 | 1) {
      const index = this.document.cues.findIndex((cue) => cue.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= this.document.cues.length) return
      this.commit('move', (cues) => {
        const [item] = cues.splice(index, 1)
        cues.splice(target, 0, item)
      }, id)
    },
    deleteCue(id: string) {
      const cue = this.document.cues.find((item) => item.id === id)
      if (!cue || cue.locked) return
      this.commit('delete', (cues) => {
        const index = cues.findIndex((item) => item.id === id)
        if (index >= 0) cues.splice(index, 1)
      }, this.document.cues[Math.max(0, this.document.cues.findIndex((item) => item.id === id) - 1)]?.id ?? null)
    },
    createSnapshot(name: string) {
      const snapshot: Snapshot = { id: makeId('snapshot'), name: name.trim() || `v${this.document.snapshots.length + 1}`, createdAt: Date.now(), cues: cloneCues(this.document.cues) }
      this.document.snapshots.unshift(snapshot)
      this.markChanged('snapshot', true)
    },
    restoreSnapshot(id: string) {
      const snapshot = this.document.snapshots.find((item) => item.id === id)
      if (!snapshot) return
      this.past.push({ label: 'restore-snapshot', cues: cloneCues(this.document.cues), selectedCueId: this.selectedCueId })
      this.future = []
      // 恢复旧版时保留当前已回传的配音棚实录（按 cue id 带回）
      const studioById = new Map(this.document.cues.map((cue) => [cue.id, cue.studio]))
      this.document.cues = cloneCues(snapshot.cues).map((cue) => ({ ...cue, studio: cue.studio ?? studioById.get(cue.id) }))
      this.selectedCueId = this.document.cues[0]?.id ?? null
      this.markChanged('restore-snapshot')
    },
    importText(text: string, filename: string) {
      const lower = filename.toLowerCase()
      const cues = lower.endsWith('.srt') ? parseSrt(text) : parseScript(text, this.document.actors)
      if (!cues.length) throw new Error('EMPTY_IMPORT')
      this.commit('import', (current) => {
        current.splice(0, current.length, ...cues)
      }, cues[0].id)
      return cues.length
    },
    exportSrt() {
      const blob = new Blob([toSrt(this.document.cues)], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${this.document.title || 'subtitle'}.srt`
      anchor.click()
      URL.revokeObjectURL(url)
    },

    // ---------- 配音棚回传 ----------

    /**
     * 配音棚回传进入：按时间码对账。
     * 实录时长与替班写入匹配台词的 studio 域；缺/多/错位挂起等人定归属。
     * 工作台字段（译文/时间码/校对状态）一律不动。
     */
    ingestStudioReturn(name: string, text: string) {
      if (!this.studioOnline) throw new Error('STUDIO_OFFLINE')
      const rows = parseStudioReturn(text)
      if (!rows.length) throw new Error('EMPTY_STUDIO_RETURN')
      const records = rows.map((row) => row.record)
      const batchId = makeId('batch')
      const { matched, pending } = reconcile(this.document.cues, records, batchId, this.document.studio.dismissed)
      const now = Date.now()
      for (const cue of this.document.cues) {
        const hit = matched.get(cue.id)
        if (!hit) continue
        cue.studio = {
          recordedStart: hit.record.start,
          recordedDuration: hit.record.duration,
          standIn: hit.record.standIn,
          note: hit.record.note,
          updatedAt: now,
          batchId,
        }
      }
      this.document.studio.pending = [...pending, ...this.document.studio.pending]
      this.document.studio.batches.unshift({ id: batchId, name: name || `回传 ${new Date(now).toLocaleString()}`, createdAt: now, appliedAt: now, records, status: 'applied' })
      this.markChanged('studio-return')
      return { batchId, matched: matched.size, pending: pending.length }
    },
    /** 挂起项人工指定归属到某条台词 */
    assignPending(pendingId: string, cueId: string) {
      const cue = this.document.cues.find((item) => item.id === cueId)
      const item = this.document.studio.pending.find((pending) => pending.id === pendingId)
      if (!cue || !item) return
      const record: StudioRecord = {
        start: item.start,
        duration: item.duration ?? Math.max(0.1, (item.end ?? cue.end) - item.start),
        standIn: item.standIn ?? '',
        note: item.note ?? '',
      }
      cue.studio = {
        recordedStart: record.start,
        recordedDuration: record.duration,
        standIn: record.standIn,
        note: record.note,
        updatedAt: Date.now(),
        batchId: item.batchId,
      }
      this.document.studio.dismissed = [...this.document.studio.dismissed, item.key]
      this.document.studio.pending = this.document.studio.pending.filter((pending) => pending.id !== pendingId)
      this.markChanged('studio-assign')
    },
    /** 忽略挂起项（缺少/多出确认无需处理） */
    dismissPending(pendingId: string) {
      const item = this.document.studio.pending.find((pending) => pending.id === pendingId)
      if (!item) return
      this.document.studio.dismissed = [...this.document.studio.dismissed, item.key]
      this.document.studio.pending = this.document.studio.pending.filter((pending) => pending.id !== pendingId)
      this.markChanged('studio-dismiss')
    },
    /** 回传失败后从配音棚侧重试：整批重新对账应用 */
    async retryBatch(batchId: string) {
      const batch = this.document.studio.batches.find((item) => item.id === batchId)
      if (!batch) return { ok: false as const }
      if (!this.studioOnline) {
        batch.error = 'STUDIO_OFFLINE'
        return { ok: false as const }
      }
      // 模拟配音棚侧重投：离线失败、在线成功
      const { matched, pending } = reconcile(this.document.cues, batch.records, batch.id, this.document.studio.dismissed)
      const now = Date.now()
      for (const cue of this.document.cues) {
        const hit = matched.get(cue.id)
        if (!hit) continue
        cue.studio = {
          recordedStart: hit.record.start,
          recordedDuration: hit.record.duration,
          standIn: hit.record.standIn,
          note: hit.record.note,
          updatedAt: now,
          batchId: batch.id,
        }
      }
      this.document.studio.pending = [
        ...pending.filter((item) => !this.document.studio.pending.some((existing) => existing.key === item.key)),
        ...this.document.studio.pending,
      ]
      batch.status = 'applied'
      batch.appliedAt = now
      batch.error = undefined
      this.markChanged('studio-retry')
      return { ok: true as const, matched: matched.size, pending: pending.length }
    },
    /** 模拟一次失败的回传（配音棚链路故障）：批次留在队列等待重试 */
    failIncomingReturn(name: string, text: string) {
      const rows = parseStudioReturn(text)
      if (!rows.length) throw new Error('EMPTY_STUDIO_RETURN')
      const batchId = makeId('batch')
      this.document.studio.batches.unshift({
        id: batchId,
        name: name || `回传 ${new Date().toLocaleString()}`,
        createdAt: Date.now(),
        records: rows.map((row) => row.record),
        status: 'failed',
        error: 'STUDIO_OFFLINE',
      })
      this.markChanged('studio-failed')
      return batchId
    },

    // ---------- 多标签字段冲突定归属 ----------

    resolveFieldConflict(index: number, side: 'local' | 'remote') {
      const conflict = this.activeConflicts[index]
      if (!conflict) return
      if (conflict.field === '__cue__') {
        const chosen = side === 'local' ? conflict.local : conflict.remote
        const exists = this.document.cues.some((cue) => cue.id === conflict.cueId)
        if (chosen && !exists) this.document.cues.push(cloneCues([chosen as Cue])[0])
        if (!chosen && exists) this.document.cues = this.document.cues.filter((cue) => cue.id !== conflict.cueId)
      } else {
        const cue = this.document.cues.find((item) => item.id === conflict.cueId)
        if (!cue) return
        const value = side === 'local' ? conflict.local : conflict.remote
        Object.assign(cue, { [conflict.field]: value })
      }
      this.resolvedConflictKeys = [...this.resolvedConflictKeys, conflictFingerprint(conflict)]
      this.markChanged('resolve-conflict')
    },
  },
})

const dedupeConflicts = (conflicts: FieldConflict[]): FieldConflict[] => {
  const seen = new Set<string>()
  return conflicts.filter((conflict) => {
    const key = conflictFingerprint(conflict)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const conflictFingerprint = (conflict: FieldConflict) =>
  `${conflict.cueId}:${conflict.field}:${JSON.stringify(conflict.remote)}`
