<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Clock, Delete, DocumentCopy, Download, EditPen, Files, Lock, MagicStick, Mic, Monitor,
  RefreshLeft, RefreshRight, Search, Unlock, UploadFilled, Bell, Connection,
} from '@element-plus/icons-vue'
import { useEditorStore } from './store/editor'
import type { Cue, CueConflict, PendingTake, WorkbenchCueField } from './types'
import { formatTime } from './utils/subtitle'
import { TIMECODE_TOLERANCE } from './utils/studio'

const store = useEditorStore()
const {
  document: project, selectedCue, selectedCueId, visibleCues, saveState, online, timelineZoom,
  actorFilter, pendingTakes, failedBatches, activeConflicts, studioOnline,
} = storeToRefs(store)
const fileInput = ref<HTMLInputElement>()
const snapshotDialog = ref(false)
const snapshotName = ref('')
const search = ref('')
const attentionTab = ref<'pending' | 'conflicts'>('pending')
const attentionOpen = ref(false)
const studioDialog = ref(false)
const studioText = ref('')
const studioBatchName = ref('')
const assignTargets = ref<Record<string, string>>({})

const filteredCues = computed(() => {
  const query = search.value.trim().toLowerCase()
  if (!query) return visibleCues.value
  return visibleCues.value.filter((cue) => `${cue.source} ${cue.target}`.toLowerCase().includes(query))
})
const selectedWarnings = computed(() => selectedCue.value ? cueWarnings(selectedCue.value) : [])
const selectedTermMismatches = computed(() => selectedCue.value ? termMismatches(selectedCue.value) : [])
const totalCharacters = computed(() => project.value.cues.reduce((sum, cue) => sum + cue.source.length + cue.target.length, 0))
const saveLabel = computed(() => ({
  saved: store.t('saved'), dirty: store.t('dirty'), saving: store.t('saving'),
}[saveState.value]))
const actorColor = (id: string) => project.value.actors.find((actor) => actor.id === id)?.color ?? '#6d7b91'
const actorName = (id: string) => project.value.actors.find((actor) => actor.id === id)?.name ?? '—'
const statusLabel = (status: Cue['status']) => store.t(status)
const statusType = (status: Cue['status']) => status === 'reviewed' ? 'success' : status === 'issue' ? 'danger' : 'info'
const selectedStudio = computed(() => selectedCue.value?.studio)
const formatDelta = (seconds: number) => (seconds > 0 ? '+' : '') + seconds.toFixed(2)
const displayValue = (value: unknown): string => {
  if (value === null || value === undefined) return '∅'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}
const FIELD_LABEL_KEYS: Record<WorkbenchCueField, Parameters<typeof store.t>[0]> = {
  start: 'start', end: 'end', source: 'source', target: 'target', actorId: 'actor',
  speed: 'speed', termIds: 'termsUsed', status: 'status', locked: 'lockedField',
}
const fieldLabel = (field: WorkbenchCueField | '__cue__') =>
  field === '__cue__' ? store.t('fieldConflictCue') : store.t(FIELD_LABEL_KEYS[field])

function pendingReasonLabel(reason: PendingTake['reason']) {
  return { missing: store.t('reasonMissing'), extra: store.t('reasonExtra'), shifted: store.t('reasonShifted') }[reason]
}
function pendingReasonType(reason: PendingTake['reason']) {
  return reason === 'missing' ? 'warning' : reason === 'extra' ? 'danger' : 'warning'
}
function pendingHint(item: PendingTake) {
  return {
    missing: store.t('reasonMissingHint'),
    extra: store.t('reasonExtraHint'),
    shifted: store.t('reasonShiftedHint'),
  }[item.reason]
}
function assignTarget(id: string) {
  const item = pendingTakes.value.find((pending) => pending.id === id)
  return assignTargets.value[id] ?? item?.suggestionCueId ?? item?.cueId ?? project.value.cues[0]?.id ?? ''
}
function loadSampleReturn() {
  studioText.value = [
    '# 时间码 | 实录时长(秒) | 替班 | 备注',
    '00:00:00,000 | 4.05 |  | 棚内首条',
    '00:00:04,300 | 4.10 | 替班-王 | 主持人感冒替录',
    '00:00:08,800 | 4.62 |  | ',
    '00:00:13,900 | 5.10 | 替班-赵 | 时间码与下一条挨太近',
    '00:00:40,000 | 3.20 | 替班-李 | 多出的一条实录',
  ].join('\n')
}
function submitStudioReturn(fail = false) {
  if (!studioText.value.trim()) {
    ElMessage.error(store.t('studioEmpty'))
    return
  }
  try {
    if (fail) {
      store.failIncomingReturn(studioBatchName.value, studioText.value)
      ElMessage.warning(store.t('returnQueuedFailed'))
    } else {
      const result = store.ingestStudioReturn(studioBatchName.value, studioText.value)
      ElMessage.success(store.t('returnApplied', { matched: result.matched, pending: result.pending }))
      attentionTab.value = 'pending'
      if (result.pending) attentionOpen.value = true
    }
    studioDialog.value = false
    studioText.value = ''
    studioBatchName.value = ''
  } catch {
    ElMessage.error(store.t('studioEmpty'))
  }
}
async function retryBatch(batchId: string) {
  const result = await store.retryBatch(batchId)
  if (result.ok) ElMessage.success(store.t('retryDone', { matched: result.matched ?? 0, pending: result.pending ?? 0 }))
  else ElMessage.error(store.t('studioOffline'))
}
function assignPending(id: string) {
  const cueId = assignTarget(id)
  if (!cueId) return
  store.assignPending(id, cueId)
  ElMessage.success(store.t('assign'))
}
function dismissPending(id: string) {
  store.dismissPending(id)
}

function updateSelected(patch: Partial<Cue>, label = 'update-cue') {
  if (selectedCue.value) store.updateCue(selectedCue.value.id, patch, label)
}
function tone(text: string) {
  const polite = (text.match(/您|请|劳驾|麻烦|敬请/g) ?? []).length
  const casual = (text.match(/你|咱们|[？?]$/g) ?? []).length
  if (polite > casual) return 'polite'
  if (casual > polite) return 'casual'
  return 'neutral'
}
function addressee(text: string) {
  const matches = text.match(/林博士|陈工|主持人|博士|老师|先生|女士|团队/g)
  return matches?.[0] ?? ''
}
function cueWarnings(cue: Cue): CueConflict[] {
  const index = project.value.cues.findIndex((item) => item.id === cue.id)
  const previous = project.value.cues[index - 1]
  const next = project.value.cues[index + 1]
  const warnings: CueConflict[] = []
  if (!previous) return warnings
  if (previous.actorId !== cue.actorId) warnings.push({ cueId: cue.id, type: 'actor', message: store.t('actorSwitch', { from: actorName(previous.actorId), to: actorName(cue.actorId) }) })
  const fromTone = tone(previous.target || previous.source)
  const currentTone = tone(cue.target || cue.source)
  if (fromTone !== 'neutral' && currentTone !== 'neutral' && fromTone !== currentTone) warnings.push({ cueId: cue.id, type: 'tone', message: store.t('toneSwitch', { from: fromTone, to: currentTone }) })
  const fromAddress = addressee(previous.source)
  const currentAddress = addressee(cue.source)
  if (fromAddress && currentAddress && fromAddress !== currentAddress) warnings.push({ cueId: cue.id, type: 'address', message: store.t('speakerSwitch', { from: fromAddress, to: currentAddress }) })
  if (!next) return warnings
  return warnings
}
function termMismatches(cue: Cue) {
  return project.value.terms.filter((term) => cue.termIds.includes(term.id) && cue.target && !cue.target.includes(term.target))
}
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const count = store.importText(await file.text(), file.name)
    ElMessage.success(store.t('importDone', { count }))
  } catch {
    ElMessage.error(store.t('importError'))
  } finally {
    input.value = ''
  }
}
function requestDelete(id: string) {
  ElMessageBox.confirm(store.t('confirmDelete'), { type: 'warning', confirmButtonText: store.t('delete') })
    .then(() => store.deleteCue(id))
    .catch(() => undefined)
}
function createSnapshot() {
  store.createSnapshot(snapshotName.value)
  snapshotName.value = ''
  snapshotDialog.value = false
  ElMessage.success(store.t('savedNow'))
}
function onKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable) return
  const key = event.key.toLowerCase()
  if ((event.metaKey || event.ctrlKey) && key === 'z') {
    event.preventDefault(); event.shiftKey ? store.redo() : store.undo(); return
  }
  if ((event.metaKey || event.ctrlKey) && key === 'y') { event.preventDefault(); store.redo(); return }
  const list = filteredCues.value
  const index = list.findIndex((cue) => cue.id === store.selectedCueId)
  if (key === 'j') { event.preventDefault(); store.selectCue(list[Math.min(list.length - 1, index + 1)]?.id ?? null); nextTick(() => document.querySelector('.cue-row.active')?.scrollIntoView({ block: 'nearest' })) }
  if (key === 'k') { event.preventDefault(); store.selectCue(list[Math.max(0, index - 1)]?.id ?? null); nextTick(() => document.querySelector('.cue-row.active')?.scrollIntoView({ block: 'nearest' })) }
  if ((key === 'a' || key === 's') && selectedCue.value) store.markStatus(selectedCue.value.id, 'reviewed')
  if (key === 'x' && selectedCue.value) store.markStatus(selectedCue.value.id, 'issue')
  if (key === 'l' && selectedCue.value) store.toggleLock(selectedCue.value.id)
}
function setOnline(value: boolean) {
  store.setOnline(value)
  ElMessage({ message: store.t(value ? 'online' : 'offline'), type: value ? 'success' : 'warning' })
}
function setStudioOnline(value: boolean) {
  store.setStudioOnline(value)
  ElMessage({ message: store.t(value ? 'studioOnline' : 'studioOffline'), type: value ? 'success' : 'warning' })
}
function focusCue(cueId?: string) {
  if (!cueId) return
  store.selectCue(cueId)
  attentionOpen.value = false
  nextTick(() => document.querySelector('.cue-row.active')?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
}
onMounted(async () => {
  await store.initialize()
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)
  await nextTick()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('online', handleOnline)
  window.removeEventListener('offline', handleOffline)
})
const handleOnline = () => setOnline(true)
const handleOffline = () => setOnline(false)
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark"><Monitor /></div>
        <div>
          <h1>{{ store.t('appTitle') }}</h1>
          <p>{{ store.t('subtitle') }}</p>
        </div>
      </div>
      <div class="top-actions">
        <el-select v-model="project.language" size="small" class="language-select" @change="store.setLocale">
          <el-option label="简体中文" value="zh-CN" />
          <el-option label="English" value="en-US" />
          <el-option label="日本語" value="ja-JP" />
        </el-select>
        <span class="save-state" :class="saveState"><i />{{ saveLabel }}</span>
        <el-button :icon="Connection" size="small" :type="studioOnline ? 'success' : 'danger'" plain @click="setStudioOnline(!studioOnline)">
          {{ store.t('studioLink') }}：{{ studioOnline ? 'ON' : 'OFF' }}
        </el-button>
        <el-badge :hidden="!store.hasAttention" :value="pendingTakes.length + failedBatches.length + activeConflicts.length" class="attention-badge">
          <el-button :icon="Bell" @click="attentionOpen = true">{{ store.t('attention') }}</el-button>
        </el-badge>
        <el-button type="warning" :icon="Mic" @click="studioDialog = true">{{ store.t('studioReturn') }}</el-button>
        <input ref="fileInput" class="file-input" type="file" accept=".srt,.txt,text/plain" @change="importFile" />
        <el-button :icon="UploadFilled" @click="fileInput?.click()">{{ store.t('import') }}</el-button>
        <el-button :icon="Download" @click="store.exportSrt">{{ store.t('export') }}</el-button>
        <el-button type="primary" :icon="DocumentCopy" @click="snapshotDialog = true">{{ store.t('snapshot') }}</el-button>
      </div>
    </header>

    <div v-if="!online" class="network-banner offline">{{ store.t('offline') }}</div>
    <div v-if="!studioOnline" class="network-banner studio-offline">{{ store.t('studioOffline') }}</div>

    <main class="workspace">
      <aside class="left-panel panel">
        <section>
          <div class="section-heading">
            <span><el-icon><Files /></el-icon>{{ store.t('actors') }}</span>
            <small>{{ project.actors.length }}</small>
          </div>
          <button class="actor-filter" :class="{ active: actorFilter === 'all' }" @click="actorFilter = 'all'">
            <span class="actor-dot all" />{{ store.t('allActors') }}
            <b>{{ project.cues.length }}</b>
          </button>
          <button v-for="actor in project.actors" :key="actor.id" class="actor-filter" :class="{ active: actorFilter === actor.id }" @click="actorFilter = actor.id">
            <span class="actor-dot" :style="{ background: actor.color }" />{{ actor.name }}
            <b>{{ project.cues.filter((cue) => cue.actorId === actor.id).length }}</b>
          </button>
        </section>
        <section>
          <div class="section-heading"><span><el-icon><EditPen /></el-icon>{{ store.t('terms') }}</span><small>{{ project.terms.length }}</small></div>
          <div v-for="term in project.terms" :key="term.id" class="term-card">
            <div><b>{{ term.source }}</b><span>→ {{ term.target }}</span></div>
            <small>{{ term.note }}</small>
          </div>
          <p class="section-note">{{ store.t('termHint') }}</p>
        </section>
        <section>
          <div class="section-heading"><span><el-icon><Mic /></el-icon>{{ store.t('batchesTitle') }}</span></div>
          <p v-if="!project.studio.batches.length" class="section-note">—</p>
          <div v-for="batch in project.studio.batches.slice(0, 6)" :key="batch.id" class="batch-card" :class="batch.status">
            <div>
              <b>{{ batch.name }}</b>
              <el-tag size="small" :type="batch.status === 'applied' ? 'success' : 'danger'">
                {{ batch.status === 'applied' ? store.t('batchApplied') : store.t('batchFailed') }}
              </el-tag>
            </div>
            <small>{{ new Date(batch.appliedAt ?? batch.createdAt).toLocaleString() }} · {{ batch.records.length }} {{ store.t('recorded') }}</small>
            <el-button v-if="batch.status === 'failed'" size="small" type="danger" plain @click="retryBatch(batch.id)">{{ store.t('retry') }}</el-button>
          </div>
        </section>
      </aside>

      <section class="center-panel">
        <div class="project-strip">
          <div>
            <el-input v-model="project.title" class="title-input" @input="store.markChanged('title')" />
            <div class="project-meta">
              <span>{{ store.t('cueCount', { count: project.cues.length }) }}</span>
              <span>{{ store.t('characterCount', { count: totalCharacters }) }}</span>
              <span>revision {{ project.revision }} · schema v{{ project.schemaVersion }}</span>
            </div>
          </div>
          <div class="history-actions">
            <el-button-group>
              <el-button :icon="RefreshLeft" :disabled="!store.past.length" @click="store.undo">{{ store.t('undo') }}</el-button>
              <el-button :icon="RefreshRight" :disabled="!store.future.length" @click="store.redo">{{ store.t('redo') }}</el-button>
            </el-button-group>
          </div>
        </div>

        <div class="timeline-card">
          <div class="section-heading">
            <span><el-icon><Clock /></el-icon>{{ store.t('timeline') }}</span>
            <div class="zoom-control"><small>{{ store.t('zoom') }}</small><el-slider v-model="timelineZoom" :min="0.7" :max="3" :step="0.1" /></div>
          </div>
          <div class="timeline-scroll">
            <div class="timeline" :style="{ width: `${timelineZoom * 100}%` }">
              <button
                v-for="cue in filteredCues" :key="cue.id" class="timeline-block" :class="{ active: cue.id === selectedCueId, issue: cue.status === 'issue', locked: cue.locked, returned: !!cue.studio }"
                :style="{ left: `${(cue.start / store.totalDuration) * 100}%`, width: `${Math.max(1.8, ((cue.end - cue.start) / store.totalDuration) * 100)}%`, borderColor: actorColor(cue.actorId) }"
                :title="`${formatTime(cue.start)} · ${cue.source}`" @click="store.selectCue(cue.id)"
              ><span>{{ actorName(cue.actorId).split('/')[0] }}</span><b>{{ cue.target || cue.source }}</b></button>
              <div class="timeline-ruler"><span v-for="tick in [0, 15, 30, 45, 60]" :key="tick" :style="{ left: `${(tick / store.totalDuration) * 100}%` }">{{ tick }}s</span></div>
            </div>
          </div>
        </div>

        <div class="cue-toolbar">
          <div class="section-heading"><span>{{ store.t('cues') }}</span><el-tag size="small" type="info">{{ filteredCues.length }}</el-tag></div>
          <el-input v-model="search" :prefix-icon="Search" clearable placeholder="搜索原文或译文" class="cue-search" />
          <el-select v-model="actorFilter" class="actor-mobile-filter">
            <el-option :label="store.t('allActors')" value="all" />
            <el-option v-for="actor in project.actors" :key="actor.id" :label="actor.name" :value="actor.id" />
          </el-select>
        </div>

        <div class="cue-list">
          <article
            v-for="(cue, index) in filteredCues" :key="cue.id" class="cue-row" :class="{ active: cue.id === selectedCueId, issue: cue.status === 'issue', locked: cue.locked }"
            tabindex="0" @click="store.selectCue(cue.id)" @keydown.enter="store.selectCue(cue.id)"
          >
            <div class="cue-number">{{ String(index + 1).padStart(2, '0') }}</div>
            <div class="cue-main">
              <div class="cue-topline">
                <span class="actor-pill" :style="{ '--actor': actorColor(cue.actorId) }">{{ actorName(cue.actorId) }}</span>
                <code>{{ formatTime(cue.start) }} → {{ formatTime(cue.end) }}</code>
                <el-tag size="small" :type="statusType(cue.status)">{{ statusLabel(cue.status) }}</el-tag>
                <el-tag v-if="cue.studio" size="small" type="success" effect="plain" class="studio-chip">
                  <el-icon><Mic /></el-icon>{{ cue.studio.recordedDuration }}s<span v-if="cue.studio.standIn"> · {{ cue.studio.standIn }}</span>
                </el-tag>
                <el-icon v-if="cue.locked"><Lock /></el-icon>
                <span class="cue-warning-count" v-if="cueWarnings(cue).length">{{ cueWarnings(cue).length }} context</span>
              </div>
              <p class="source-text">{{ cue.source }}</p>
              <p class="target-text" :class="{ empty: !cue.target }">{{ cue.target || '尚未填写译文' }}</p>
            </div>
            <div class="cue-quick-actions">
              <el-button size="small" text :icon="MagicStick" @click.stop="store.splitCue(cue.id)">{{ store.t('split') }}</el-button>
              <el-button size="small" text :icon="Files" @click.stop="store.mergeNext(cue.id)">{{ store.t('merge') }}</el-button>
              <el-button size="small" text :icon="Delete" @click.stop="requestDelete(cue.id)" />
            </div>
          </article>
          <div v-if="!filteredCues.length" class="empty-state">{{ store.t('empty') }}</div>
        </div>
      </section>

      <aside class="right-panel panel">
        <div class="section-heading">
          <span><el-icon><EditPen /></el-icon>{{ store.t('inspector') }}</span>
          <span v-if="selectedCue" class="cue-index">#{{ project.cues.findIndex((cue) => cue.id === selectedCue?.id) + 1 }}</span>
        </div>
        <div v-if="selectedCue" class="inspector">
          <template v-if="selectedCue.locked">
            <div class="locked-note"><el-icon><Lock /></el-icon>{{ store.t('locked') }}</div>
          </template>
          <label>{{ store.t('actor') }}</label>
          <el-select :model-value="selectedCue.actorId" :disabled="selectedCue.locked" @change="updateSelected({ actorId: String($event) }, 'actor')">
            <el-option v-for="actor in project.actors" :key="actor.id" :label="actor.name" :value="actor.id" />
          </el-select>
          <div class="two-columns">
            <div><label>{{ store.t('start') }}</label><el-input-number :model-value="selectedCue.start" :disabled="selectedCue.locked" :min="0" :step="0.1" controls-position="right" @change="updateSelected({ start: Number($event) }, 'start-time')" /></div>
            <div><label>{{ store.t('end') }}</label><el-input-number :model-value="selectedCue.end" :disabled="selectedCue.locked" :min="selectedCue.start + 0.1" :step="0.1" controls-position="right" @change="updateSelected({ end: Number($event) }, 'end-time')" /></div>
          </div>
          <label>{{ store.t('source') }}</label>
          <el-input :model-value="selectedCue.source" type="textarea" :rows="4" :disabled="selectedCue.locked" @change="updateSelected({ source: String($event) }, 'source-text')" />
          <label>{{ store.t('target') }}</label>
          <el-input :model-value="selectedCue.target" type="textarea" :rows="5" :disabled="selectedCue.locked" @change="updateSelected({ target: String($event) }, 'target-text')" />
          <div class="two-columns">
            <div><label>{{ store.t('speed') }}</label><el-input-number :model-value="selectedCue.speed" :disabled="selectedCue.locked" :min="0.5" :max="1.8" :step="0.01" controls-position="right" @change="updateSelected({ speed: Number($event) }, 'speed')" /></div>
            <div><label>{{ store.t('status') }}</label><el-select :model-value="selectedCue.status" :disabled="selectedCue.locked" @change="store.markStatus(selectedCue.id, $event)"><el-option :label="store.t('draft')" value="draft" /><el-option :label="store.t('reviewed')" value="reviewed" /><el-option :label="store.t('issue')" value="issue" /></el-select></div>
          </div>
          <label>{{ store.t('termsUsed') }}</label>
          <el-select :model-value="selectedCue.termIds" multiple :disabled="selectedCue.locked" @change="updateSelected({ termIds: $event }, 'terms')">
            <el-option v-for="term in project.terms" :key="term.id" :label="`${term.source} → ${term.target}`" :value="term.id" />
          </el-select>
          <div class="inspector-actions">
            <el-button :icon="selectedCue.locked ? Unlock : Lock" @click="store.toggleLock(selectedCue.id)">{{ selectedCue.locked ? store.t('unlock') : store.t('lock') }}</el-button>
            <el-button @click="store.moveCue(selectedCue.id, -1)">↑ {{ store.t('moveUp') }}</el-button>
            <el-button @click="store.moveCue(selectedCue.id, 1)">↓ {{ store.t('moveDown') }}</el-button>
          </div>

          <div class="studio-card" :class="{ empty: !selectedStudio }">
            <h3><el-icon><Mic /></el-icon>{{ store.t('studioSection') }}</h3>
            <template v-if="selectedStudio">
              <div class="studio-grid">
                <div><label>{{ store.t('recordedStart') }}</label><code>{{ formatTime(selectedStudio.recordedStart, '.') }}</code></div>
                <div><label>{{ store.t('recordedDuration') }}</label><code>{{ selectedStudio.recordedDuration }}s</code></div>
                <div><label>{{ store.t('standIn') }}</label><span>{{ selectedStudio.standIn || '—' }}</span></div>
                <div>
                  <label>{{ store.t('timecode') }}</label>
                  <el-tag size="small" :type="Math.abs(selectedStudio.recordedStart - selectedCue!.start) > TIMECODE_TOLERANCE ? 'danger' : 'success'">
                    {{ store.t('drift', { delta: formatDelta(selectedStudio.recordedStart - selectedCue!.start) }) }}
                  </el-tag>
                </div>
              </div>
              <p v-if="selectedStudio.note" class="studio-note">{{ selectedStudio.note }}</p>
            </template>
            <p v-else class="check-ok">{{ store.t('noStudioData') }}</p>
          </div>

          <div class="check-card">
            <h3>{{ store.t('warnings') }}</h3>
            <p v-if="!selectedWarnings.length" class="check-ok">{{ store.t('noWarnings') }}</p>
            <p v-for="warning in selectedWarnings" :key="warning.type" class="check-warning">{{ warning.message }}</p>
            <p v-for="term in selectedTermMismatches" :key="term.id" class="check-warning">{{ store.t('termMismatch', { source: term.source, target: term.target }) }}</p>
            <p v-if="selectedCue.termIds.length && !selectedTermMismatches.length" class="check-ok">{{ store.t('noTermMismatch') }}</p>
          </div>
        </div>
        <div v-else class="empty-inspector">{{ store.t('selectHint') }}</div>
      </aside>
    </main>

    <footer class="shortcut-bar">
      <strong>{{ store.t('shortcuts') }}</strong>
      <span><kbd>J</kbd> {{ store.t('shortcutNext') }}</span>
      <span><kbd>K</kbd> {{ store.t('shortcutPrev') }}</span>
      <span><kbd>A</kbd> {{ store.t('shortcutReview') }}</span>
      <span><kbd>X</kbd> {{ store.t('shortcutIssue') }}</span>
      <span><kbd>L</kbd> {{ store.t('shortcutLock') }}</span>
      <span><kbd>Ctrl/⌘ Z</kbd> {{ store.t('shortcutUndo') }}</span>
    </footer>

    <!-- 待处理：回传挂起 + 多标签字段冲突 -->
    <el-drawer v-model="attentionOpen" :title="store.t('attention')" size="560px">
      <el-tabs v-model="attentionTab">
        <el-tab-pane :name="'pending'">
          <template #label>
            <span><el-icon><Mic /></el-icon> {{ store.t('pendingTitle') }}
              <el-badge v-if="pendingTakes.length" :value="pendingTakes.length" type="warning" />
            </span>
          </template>
          <div v-if="failedBatches.length" class="failed-banner">
            <span>{{ store.t('failedBatches', { count: failedBatches.length }) }}</span>
          </div>
          <p v-if="!pendingTakes.length && !failedBatches.length" class="empty-state">{{ store.t('noAttention') }}</p>
          <div v-for="batch in failedBatches" :key="`retry-${batch.id}`" class="batch-retry-row">
            <div>
              <b>{{ batch.name }}</b>
              <small>{{ new Date(batch.createdAt).toLocaleString() }} · {{ batch.records.length }} {{ store.t('recorded') }}</small>
            </div>
            <el-button size="small" type="danger" :icon="RefreshLeft" @click="retryBatch(batch.id)">{{ store.t('retry') }}</el-button>
          </div>
          <div v-for="item in pendingTakes" :key="item.id" class="pending-card">
            <div class="pending-head">
              <el-tag size="small" :type="pendingReasonType(item.reason)">{{ pendingReasonLabel(item.reason) }}</el-tag>
              <code>{{ formatTime(item.start, '.') }}<template v-if="item.duration"> · {{ item.duration }}s</template></code>
            </div>
            <p class="pending-hint">{{ pendingHint(item) }}</p>
            <div v-if="item.standIn || item.note" class="pending-meta">
              <span v-if="item.standIn">{{ store.t('standIn') }}：{{ item.standIn }}</span>
              <span v-if="item.note">{{ item.note }}</span>
            </div>
            <div v-if="item.reason === 'missing' && item.cueId" class="pending-actions">
              <el-button size="small" text @click="focusCue(item.cueId)">#{{ project.cues.findIndex((cue) => cue.id === item.cueId) + 1 }}</el-button>
              <el-button size="small" @click="dismissPending(item.id)">{{ store.t('dismiss') }}</el-button>
            </div>
            <div v-else class="pending-actions">
              <el-select :model-value="assignTarget(item.id)" size="small" class="assign-select" @change="assignTargets[item.id] = String($event)">
                <el-option
                  v-for="cue in project.cues" :key="cue.id"
                  :label="`#${project.cues.findIndex((c) => c.id === cue.id) + 1} ${formatTime(cue.start, '.')} ${cue.source.slice(0, 14)}`"
                  :value="cue.id"
                />
              </el-select>
              <el-button size="small" type="primary" @click="assignPending(item.id)">{{ store.t('assign') }}</el-button>
              <el-button size="small" @click="dismissPending(item.id)">{{ store.t('dismiss') }}</el-button>
            </div>
          </div>
        </el-tab-pane>
        <el-tab-pane name="conflicts">
          <template #label>
            <span>{{ store.t('fieldConflictTitle') }}
              <el-badge v-if="activeConflicts.length" :value="activeConflicts.length" type="danger" />
            </span>
          </template>
          <div class="conflict-intro">
            <el-icon><Bell /></el-icon>{{ store.t('fieldConflictBody') }}
          </div>
          <p v-if="!activeConflicts.length" class="empty-state">{{ store.t('noAttention') }}</p>
          <div v-for="(conflict, index) in activeConflicts" :key="`${conflict.cueId}-${conflict.field}-${index}`" class="conflict-card">
            <div class="pending-head">
              <el-tag size="small" type="danger">{{ fieldLabel(conflict.field) }}</el-tag>
              <el-button size="small" text @click="focusCue(conflict.cueId)">#{{ project.cues.findIndex((cue) => cue.id === conflict.cueId) + 1 }}</el-button>
            </div>
            <div class="conflict-values">
              <div class="conflict-side local">
                <small>{{ store.t('acceptLocal') }}</small>
                <pre>{{ displayValue(conflict.local) }}</pre>
                <el-button size="small" @click="store.resolveFieldConflict(index, 'local')">{{ store.t('acceptLocal') }}</el-button>
              </div>
              <div class="conflict-side remote">
                <small>{{ store.t('acceptRemote') }}</small>
                <pre>{{ displayValue(conflict.remote) }}</pre>
                <el-button size="small" type="primary" @click="store.resolveFieldConflict(index, 'remote')">{{ store.t('acceptRemote') }}</el-button>
              </div>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </el-drawer>

    <!-- 配音棚回传录入 -->
    <el-dialog v-model="studioDialog" :title="store.t('studioReturn')" width="640px">
      <el-input v-model="studioBatchName" size="small" :placeholder="store.t('newSnapshotName')" class="batch-name-input" />
      <el-input v-model="studioText" type="textarea" :rows="9" :placeholder="'00:00:00,000 | 4.2 | 替班 | 备注'" class="studio-textarea" />
      <p class="section-note">{{ store.t('studioReturnHint') }}</p>
      <p class="section-note">±{{ TIMECODE_TOLERANCE }}s · {{ store.t('pendingTitle') }}</p>
      <template #footer>
        <el-button @click="loadSampleReturn">{{ store.t('sampleReturn') }}</el-button>
        <el-button type="danger" plain @click="submitStudioReturn(true)">{{ store.t('simulateFail') }}</el-button>
        <el-button type="primary" @click="submitStudioReturn(false)">{{ store.t('studioReturn') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="snapshotDialog" :title="store.t('snapshot')" width="460px">
      <el-input v-model="snapshotName" :placeholder="store.t('newSnapshotName')" @keyup.enter="createSnapshot" />
      <div class="snapshot-list">
        <div v-for="snapshot in project.snapshots" :key="snapshot.id" class="snapshot-item">
          <div><b>{{ snapshot.name }}</b><small>{{ store.t('createdAt') }} {{ new Date(snapshot.createdAt).toLocaleString() }}</small></div>
          <span>{{ store.t('cueCount', { count: snapshot.cues.length }) }}</span>
          <el-button size="small" @click="store.restoreSnapshot(snapshot.id); snapshotDialog = false">{{ store.t('restore') }}</el-button>
        </div>
        <p v-if="!project.snapshots.length" class="empty-state">{{ store.t('noSnapshots') }}</p>
      </div>
      <template #footer><el-button type="primary" @click="createSnapshot">{{ store.t('snapshot') }}</el-button></template>
    </el-dialog>
  </div>
</template>
