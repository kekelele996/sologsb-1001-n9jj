import type { Cue, EditorDocument, FieldConflict, Snapshot, StudioBatch } from '../types'
import { SCHEMA_VERSION, WORKBENCH_CUE_FIELDS } from '../types'

const DB_NAME = 'sologsb-1001'
const STORE = 'documents'
const CURRENT_DB_VERSION = 2

const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, CURRENT_DB_VERSION)
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' })
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const transact = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) => {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const request = action(tx.objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
    tx.onerror = () => reject(tx.error)
  })
}

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  const keysA = Object.keys(a as Record<string, unknown>)
  const keysB = Object.keys(b as Record<string, unknown>)
  if (keysA.length !== keysB.length) return false
  return keysA.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

/** 旧稿结构升级：v1（无 schemaVersion）→ 当前版本，升级后可继续编辑 */
export const migrateDocument = (raw: EditorDocument): EditorDocument => {
  const doc: EditorDocument = { ...raw }
  if (!doc.schemaVersion || doc.schemaVersion < 2) {
    // v2：配音棚数据从内联于台词的字段拆到独立归属域 cue.studio
    doc.cues = (doc.cues ?? []).map((cue) => {
      const next: Cue = { ...cue }
      const legacy = cue as unknown as Record<string, unknown>
      if (!next.studio && (legacy.recordedDuration !== undefined || legacy.standIn !== undefined)) {
        next.studio = {
          recordedStart: typeof legacy.recordedStart === 'number' ? legacy.recordedStart : next.start,
          recordedDuration: typeof legacy.recordedDuration === 'number' ? legacy.recordedDuration : 0,
          standIn: typeof legacy.standIn === 'string' ? legacy.standIn : '',
          note: typeof legacy.studioNote === 'string' ? legacy.studioNote : '',
          updatedAt: typeof legacy.recordedAt === 'number' ? legacy.recordedAt : 0,
          batchId: 'legacy',
        }
      }
      return next
    })
    doc.studio = doc.studio ?? { batches: [], pending: [], dismissed: [] }
    doc.studio.batches ??= []
    doc.studio.pending ??= []
    doc.studio.dismissed ??= []
    doc.schemaVersion = 2
  }
  if (doc.schemaVersion < SCHEMA_VERSION) doc.schemaVersion = SCHEMA_VERSION
  return doc
}

export const loadDocumentRaw = (id: string) => transact<EditorDocument | undefined>('readonly', (store) => store.get(id))

export const loadDocument = async (id: string): Promise<EditorDocument | undefined> => {
  const raw = await loadDocumentRaw(id)
  return raw ? migrateDocument(raw) : undefined
}

export interface MergeResult {
  document: EditorDocument
  conflicts: FieldConflict[]
  /** 是否真的合入了来自远端（其他标签）的内容 */
  mergedRemote: boolean
}

interface CueMerge {
  cue?: Cue
  conflicts: FieldConflict[]
  mergedRemote: boolean
}

/** 单条台词三方合并；undefined 表示双方最终都删除 */
const mergeCue = (id: string, base: Cue | undefined, local: Cue | undefined, remote: Cue | undefined): CueMerge => {
  const conflicts: FieldConflict[] = []

  if (local && remote) {
    const next: Cue = { ...local }
    let touchedByRemote = false
    if (base) for (const field of WORKBENCH_CUE_FIELDS) {
      const b = base[field]
      const l = local[field]
      const r = remote[field]
      const localChanged = !deepEqual(l, b)
      const remoteChanged = !deepEqual(r, b)
      if (!localChanged && remoteChanged) {
        Object.assign(next, { [field]: r })
        touchedByRemote = true
      } else if (localChanged && remoteChanged && !deepEqual(l, r)) {
        // 同一字段两边都改且不一致：保留本地值，登记冲突等人定归属
        conflicts.push({ cueId: id, field, base: b, local: l, remote: r })
      }
    }
    // studio 域归配音棚：取较新回传，工作台保存永远不会清掉它
    const localStudioAt = local.studio?.updatedAt ?? -1
    const remoteStudioAt = remote.studio?.updatedAt ?? -1
    if (remote.studio && remoteStudioAt > localStudioAt) {
      next.studio = remote.studio
      touchedByRemote = true
    }
    return { cue: next, conflicts, mergedRemote: touchedByRemote }
  }

  if (local && !remote) {
    if (!base) return { cue: local, conflicts, mergedRemote: false } // 本地新建的台词，远端还没有：直接保留
    const localChanged = !deepEqual(local, base)
    if (!localChanged) return { conflicts, mergedRemote: false } // 远端删除、本地未动：接受删除
    // 远端删了、本地改过：挂起，暂保留本地版本
    conflicts.push({ cueId: id, field: '__cue__', base, local, remote: null })
    return { cue: local, conflicts, mergedRemote: false }
  }

  if (!local && remote) {
    if (!base) return { cue: remote, conflicts, mergedRemote: true } // 远端新建的台词，本地基线里没有：直接合入
    const remoteChanged = !deepEqual(remote, base)
    if (!remoteChanged) return { conflicts, mergedRemote: false } // 本地删除、远端未动：接受删除
    // 本地删了、远端改过：挂起，暂取远端以免丢失改动
    conflicts.push({ cueId: id, field: '__cue__', base, local: null, remote })
    return { cue: remote, conflicts, mergedRemote: true }
  }

  return { conflicts, mergedRemote: false }
}

const mergeCueLists = (
  baseCues: Cue[] | undefined,
  localCues: Cue[],
  remoteCues: Cue[],
): { cues: Cue[]; conflicts: FieldConflict[]; mergedRemote: boolean } => {
  const baseMap = new Map((baseCues ?? []).map((cue) => [cue.id, cue]))
  const localMap = new Map(localCues.map((cue) => [cue.id, cue]))
  const remoteMap = new Map(remoteCues.map((cue) => [cue.id, cue]))
  const conflicts: FieldConflict[] = []
  let mergedRemote = false

  // 顺序以本地为主，追加本地没有的远端/基线 id（新建台词场景）
  const order: string[] = []
  const seen = new Set<string>()
  for (const cue of localCues) {
    order.push(cue.id)
    seen.add(cue.id)
  }
  for (const cue of remoteCues) {
    if (!seen.has(cue.id)) {
      order.push(cue.id)
      seen.add(cue.id)
    }
  }

  const cues: Cue[] = []
  for (const id of order) {
    const result = mergeCue(id, baseMap.get(id), localMap.get(id), remoteMap.get(id))
    conflicts.push(...result.conflicts)
    if (result.mergedRemote) mergedRemote = true
    if (result.cue) cues.push(result.cue)
  }
  return { cues, conflicts, mergedRemote }
}

const mergeSnapshots = (local: Snapshot[], remote: Snapshot[]): Snapshot[] => {
  const map = new Map<string, Snapshot>()
  for (const snapshot of [...remote, ...local]) if (!map.has(snapshot.id)) map.set(snapshot.id, snapshot)
  const ids = new Set(local.map((snapshot) => snapshot.id))
  return [...local, ...remote.filter((snapshot) => !ids.has(snapshot.id))].map((snapshot) => map.get(snapshot.id)!)
}

const mergeBatches = (local: StudioBatch[], remote: StudioBatch[]): StudioBatch[] => {
  const map = new Map<string, StudioBatch>()
  for (const batch of [...local, ...remote]) {
    const existing = map.get(batch.id)
    if (!existing) {
      map.set(batch.id, batch)
      continue
    }
    // 同一批次：已成功的状态优先；否则取较新的
    const winner = existing.status === 'applied'
      ? existing
      : batch.status === 'applied'
        ? batch
        : (batch.createdAt > existing.createdAt ? batch : existing)
    map.set(batch.id, winner)
  }
  const ids = new Set(local.map((batch) => batch.id))
  return [...local, ...remote.filter((batch) => !ids.has(batch.id))].map((batch) => map.get(batch.id)!)
}

/**
 * 字段级三方合并（base = 本标签最后一次看到的库内版本）：
 * - 工作台字段（译文/时间码/校对状态等）：谁改了取谁的，同字段两边都改且不一致才挂冲突
 * - studio 域（实录时长/替班）：归配音棚，按回传时间取新，与工作台字段互不覆盖
 */
export const mergeDocuments = (base: EditorDocument | undefined, local: EditorDocument, remote: EditorDocument): MergeResult => {
  const { cues, conflicts, mergedRemote } = mergeCueLists(base?.cues, local.cues, remote.cues)
  let touched = mergedRemote

  const localPending = local.studio?.pending ?? []
  const remotePending = remote.studio?.pending ?? []
  const pendingIds = new Set(localPending.map((item) => item.id))
  const mergedPending = [...localPending, ...remotePending.filter((item) => !pendingIds.has(item.id))]
  const mergedDismissed = [...new Set([...(local.studio?.dismissed ?? []), ...(remote.studio?.dismissed ?? [])])]
  const mergedBatches = mergeBatches(local.studio?.batches ?? [], remote.studio?.batches ?? [])
  if (remotePending.length || (remote.studio?.batches?.length ?? 0) > (local.studio?.batches?.length ?? 0)) touched = true

  const pick = <T>(key: 'title' | 'language' | 'actors' | 'terms'): T => {
    const b = base?.[key]
    const l = local[key]
    const r = remote[key]
    if (base && !deepEqual(r, b) && deepEqual(l, b)) {
      touched = true
      return r as T
    }
    return l as T
  }

  return {
    document: {
      ...remote,
      id: local.id,
      title: pick('title'),
      language: pick('language'),
      actors: pick('actors'),
      terms: pick('terms'),
      cues,
      snapshots: mergeSnapshots(local.snapshots ?? [], remote.snapshots ?? []),
      studio: { batches: mergedBatches, pending: mergedPending, dismissed: mergedDismissed },
    },
    conflicts,
    mergedRemote: touched,
  }
}

export interface SaveOutcome {
  document: EditorDocument
  conflicts: FieldConflict[]
}

/**
 * 保存：读库内最新版本做字段级合并后落库，晚保存不会整篇覆盖别人。
 * @param document 本标签当前文档
 * @param base    本标签最后一次同步到的库内版本（三方合并的共同祖先）
 */
export const saveDocument = async (document: EditorDocument, base?: EditorDocument): Promise<SaveOutcome> => {
  const db = await openDb()
  return new Promise<SaveOutcome>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const getRequest = store.get(document.id)
    let outcome: SaveOutcome | undefined
    getRequest.onsuccess = () => {
      const stored = getRequest.result as EditorDocument | undefined
      const local = migrateDocument(document)
      let next: EditorDocument
      let conflicts: FieldConflict[] = []
      if (stored) {
        const migratedStored = migrateDocument(stored)
        if (base && base.revision === migratedStored.revision) {
          // 本标签基线就是最新版：远端没有新写入，直接落本地，不做合并
          next = { ...local }
        } else {
          // 有共同祖先就做真正的三方合并；没有（刚升级/首次保存）则以库内版为基线
          const ancestor = base ? migrateDocument(base) : migratedStored
          const merged = mergeDocuments(ancestor, local, migratedStored)
          next = { ...merged.document, id: document.id }
          conflicts = merged.conflicts
        }
      } else {
        next = { ...local }
      }
      next = { ...next, schemaVersion: SCHEMA_VERSION, revision: (stored?.revision ?? local.revision ?? 0) + 1, updatedAt: Date.now() }
      store.put(next)
      outcome = { document: next, conflicts }
    }
    tx.oncomplete = () => {
      db.close()
      if (outcome) resolve(outcome)
    }
    tx.onerror = () => { db.close(); reject(tx.error) }
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error('TRANSACTION_ABORTED')) }
  })
}
