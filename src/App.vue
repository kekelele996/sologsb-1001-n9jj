<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Clock, Delete, DocumentCopy, Download, EditPen, Files, Lock, MagicStick, Microphone, Monitor,
  RefreshLeft, RefreshRight, Search, Unlock, UploadFilled,
} from '@element-plus/icons-vue'
import { useEditorStore } from './store/editor'
import type { Cue, CueConflict, StudioReturn, StudioReturnItem } from './types'
import { formatTime } from './utils/subtitle'

const store = useEditorStore()
const { document: project, selectedCue, selectedCueId, visibleCues, saveState, conflict, online, timelineZoom, actorFilter } = storeToRefs(store)
const fileInput = ref<HTMLInputElement>()
const snapshotDialog = ref(false)
const snapshotName = ref('')
const search = ref('')
const studioDialog = ref(false)
const returnFileInput = ref<HTMLInputElement>()

const filteredCues = computed(() => {
  const query = search.value.trim().toLowerCase()
  if (!query) return visibleCues.value
  return visibleCues.value.filter((cue) => `${cue.source} ${cue.target}`.toLowerCase().includes(query))
})
const selectedWarnings = computed(() => selectedCue.value ? cueWarnings(selectedCue.value) : [])
const selectedTermMismatches = computed(() => selectedCue.value ? termMismatches(selectedCue.value) : [])
const totalCharacters = computed(() => project.value.cues.reduce((sum, cue) => sum + cue.source.length + cue.target.length, 0))
const saveLabel = computed(() => ({
  saved: store.t('saved'), dirty: store.t('dirty'), saving: store.t('saving'), conflict: store.t('conflict'),
}[saveState.value]))
const actorColor = (id: string) => project.value.actors.find((actor) => actor.id === id)?.color ?? '#6d7b91'
const actorName = (id: string) => project.value.actors.find((actor) => actor.id === id)?.name ?? '—'
const statusLabel = (status: Cue['status']) => store.t(status)
const statusType = (status: Cue['status']) => status === 'reviewed' ? 'success' : status === 'issue' ? 'danger' : 'info'

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
// —— 配音棚回传 ——
async function importReturnFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const record = await store.importStudioReturn(file)
    if (record.parseFailed) {
      ElMessage.warning(store.t('returnParseError'))
    } else {
      const applied = record.items.filter((item) => item.status === 'applied' || item.status === 'assigned').length
      const pending = record.items.filter((item) => item.status === 'pending').length
      ElMessage.success(store.t('returnImported', { applied, pending }))
    }
  } catch {
    ElMessage.error(store.t('importError'))
  } finally {
    input.value = ''
  }
}
function simulateReturn() {
  const record = store.simulateStudioReturn()
  const applied = record.items.filter((item) => item.status === 'applied' || item.status === 'assigned').length
  const pending = record.items.filter((item) => item.status === 'pending').length
  ElMessage.success(store.t('returnImported', { applied, pending }))
}
function retryReturn(returnId: string) {
  store.retryStudioReturn(returnId)
  ElMessage.success(store.t('retryFromStudio'))
}
function assignItem(returnId: string, itemId: string, cueId: string) {
  store.assignReturnItem(returnId, itemId, cueId)
}
function acceptSuggestion(returnId: string, item: StudioReturnItem) {
  if (item.suggestedCueId) store.assignReturnItem(returnId, item.id, item.suggestedCueId)
}
function discardItem(returnId: string, itemId: string) {
  store.discardReturnItem(returnId, itemId)
}
function ackItem(returnId: string, itemId: string) {
  store.acknowledgeMissing(returnId, itemId)
}
function kindLabel(kind: StudioReturnItem['kind']) {
  return store.t(kind === 'matched' ? 'matched' : kind === 'misaligned' ? 'misaligned' : kind === 'extra' ? 'extra' : 'missing')
}
function kindTagType(kind: StudioReturnItem['kind']) {
  return kind === 'matched' ? 'success' : kind === 'misaligned' ? 'warning' : kind === 'extra' ? 'danger' : 'info'
}
function returnStatusLabel(status: StudioReturnItem['status']) {
  return store.t(status === 'applied' ? 'applied' : status === 'assigned' ? 'assigned' : status === 'discarded' ? 'discarded' : status === 'ignored' ? 'ignored' : 'pending')
}
function returnStatusTagType(status: StudioReturnItem['status']) {
  return status === 'applied' || status === 'assigned' ? 'success' : status === 'pending' ? 'warning' : 'info'
}
function recordAppliedCount(record: StudioReturn) {
  return record.items.filter((item) => item.status === 'applied' || item.status === 'assigned').length
}
function recordPendingCount(record: StudioReturn) {
  return record.items.filter((item) => item.status === 'pending').length
}
function cueLabel(cueId?: string) {
  const cue = project.value.cues.find((item) => item.id === cueId)
  return cue ? `${formatTime(cue.start)} · ${cue.source.slice(0, 20)}` : '—'
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
        <input ref="fileInput" class="file-input" type="file" accept=".srt,.txt,text/plain" @change="importFile" />
        <el-button :icon="UploadFilled" @click="fileInput?.click()">{{ store.t('import') }}</el-button>
        <el-button :icon="Download" @click="store.exportSrt">{{ store.t('export') }}</el-button>
        <el-badge :value="store.pendingReturnCount" :hidden="!store.pendingReturnCount" class="return-badge">
          <el-button :icon="Microphone" @click="studioDialog = true">{{ store.t('studioReturn') }}</el-button>
        </el-badge>
        <el-button type="primary" :icon="DocumentCopy" @click="snapshotDialog = true">{{ store.t('snapshot') }}</el-button>
      </div>
    </header>

    <div v-if="!online" class="network-banner offline">{{ store.t('offline') }}</div>

    <div v-if="conflict" class="conflict-banner">
      <div>
        <strong>{{ store.t('conflictTitle') }}</strong>
        <span>{{ store.t('conflictBody') }}</span>
      </div>
      <div class="conflict-actions">
        <el-button size="small" @click="store.loadLatest">{{ store.t('loadLatest') }}</el-button>
        <el-button size="small" type="danger" @click="store.keepMine">{{ store.t('keepMine') }}</el-button>
      </div>
    </div>

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
      </aside>

      <section class="center-panel">
        <div class="project-strip">
          <div>
            <el-input v-model="project.title" class="title-input" @input="store.markChanged('title')" />
            <div class="project-meta">
              <span>{{ store.t('cueCount', { count: project.cues.length }) }}</span>
              <span>{{ store.t('characterCount', { count: totalCharacters }) }}</span>
              <span>revision {{ project.revision }}</span>
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
                v-for="cue in filteredCues" :key="cue.id" class="timeline-block" :class="{ active: cue.id === selectedCueId, issue: cue.status === 'issue', locked: cue.locked, 'has-studio': cue.actualDuration != null || !!cue.dubActorName }"
                :style="{ left: `${(cue.start / store.totalDuration) * 100}%`, width: `${Math.max(1.8, ((cue.end - cue.start) / store.totalDuration) * 100)}%`, borderColor: actorColor(cue.actorId) }"
                :title="`${formatTime(cue.start)} · ${cue.source}${cue.actualDuration != null ? ` · ${store.t('actualDuration')} ${cue.actualDuration}s` : ''}`" @click="store.selectCue(cue.id)"
              ><span>{{ actorName(cue.actorId).split('/')[0] }}</span><b>{{ cue.target || cue.source }}</b><i v-if="cue.actualDuration != null || cue.dubActorName" class="studio-dot" /></button>
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
                <el-icon v-if="cue.locked"><Lock /></el-icon>
                <span class="cue-warning-count" v-if="cueWarnings(cue).length">{{ cueWarnings(cue).length }} context</span>
              </div>
              <div v-if="cue.actualDuration != null || cue.dubActorName" class="cue-studio-line" :title="store.t('studioOwned')">
                <el-icon><Microphone /></el-icon>
                <span v-if="cue.actualDuration != null">{{ store.t('actualDuration') }} <b>{{ cue.actualDuration }}s</b></span>
                <span v-if="cue.dubActorName">{{ store.t('dubActor') }} <b>{{ cue.dubActorName }}</b></span>
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

          <div class="check-card">
            <h3>{{ store.t('warnings') }}</h3>
            <p v-if="!selectedWarnings.length" class="check-ok">{{ store.t('noWarnings') }}</p>
            <p v-for="warning in selectedWarnings" :key="warning.type" class="check-warning">{{ warning.message }}</p>
            <p v-for="term in selectedTermMismatches" :key="term.id" class="check-warning">{{ store.t('termMismatch', { source: term.source, target: term.target }) }}</p>
            <p v-if="selectedCue.termIds.length && !selectedTermMismatches.length" class="check-ok">{{ store.t('noTermMismatch') }}</p>
          </div>

          <div v-if="selectedCue.actualDuration != null || selectedCue.dubActorName" class="studio-fields">
            <div class="studio-fields-heading"><el-icon><Microphone /></el-icon>{{ store.t('studioOwned') }}</div>
            <div v-if="selectedCue.actualDuration != null" class="studio-field"><label>{{ store.t('actualDuration') }}</label><b>{{ selectedCue.actualDuration }}s</b></div>
            <div v-if="selectedCue.dubActorName" class="studio-field"><label>{{ store.t('dubActor') }}</label><b>{{ selectedCue.dubActorName }}</b></div>
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

    <el-dialog v-model="studioDialog" :title="store.t('studioReturn')" width="840px" top="6vh">
      <div class="studio-intro">
        <p>{{ store.t('studioReturnHint') }}</p>
        <p class="studio-file-hint">{{ store.t('returnFileHint') }}</p>
      </div>
      <div class="studio-actions">
        <input ref="returnFileInput" class="file-input" type="file" accept=".json,application/json" @change="importReturnFile" />
        <el-button type="primary" :icon="UploadFilled" @click="returnFileInput?.click()">{{ store.t('importReturn') }}</el-button>
        <el-button :icon="MagicStick" @click="simulateReturn">{{ store.t('simulateReturn') }}</el-button>
      </div>

      <div v-for="record in project.studioReturns" :key="record.id" class="return-batch">
        <div class="return-batch-head">
          <div class="return-batch-title">
            <el-icon><Microphone /></el-icon>
            <b>{{ record.source === 'simulated' ? store.t('simulateReturn') : record.source }}</b>
            <small>{{ new Date(record.importedAt).toLocaleString() }}</small>
          </div>
          <div class="return-batch-stats">
            <el-tag v-if="record.parseFailed" type="danger" size="small">{{ store.t('parseFailed') }}</el-tag>
            <template v-else>
              <el-tag type="success" size="small">{{ store.t('appliedCount', { count: recordAppliedCount(record) }) }}</el-tag>
              <el-tag v-if="recordPendingCount(record)" type="warning" size="small">{{ store.t('pendingCount', { count: recordPendingCount(record) }) }}</el-tag>
            </template>
            <el-button v-if="record.parseFailed || recordPendingCount(record)" size="small" :icon="RefreshRight" @click="retryReturn(record.id)">{{ store.t('retryFromStudio') }}</el-button>
          </div>
        </div>
        <p v-if="record.parseFailed" class="return-parse-error">{{ store.t('returnParseError') }}</p>
        <div v-if="!record.parseFailed" class="return-items">
          <div v-for="item in record.items" :key="item.id" class="return-item" :class="item.kind">
            <div class="return-item-main">
              <el-tag size="small" :type="kindTagType(item.kind)" effect="dark">{{ kindLabel(item.kind) }}</el-tag>
              <template v-if="item.kind !== 'missing'">
                <code v-if="item.timecode != null">{{ formatTime(item.timecode) }}s</code>
                <span class="return-duration">{{ store.t('actualDuration') }} <b>{{ item.actualDuration }}s</b></span>
                <span v-if="item.dubActorName" class="return-dub">{{ store.t('dubActor') }} <b>{{ item.dubActorName }}</b></span>
              </template>
              <template v-else>
                <span class="return-missing-cue">{{ cueLabel(item.missingCueId) }}</span>
              </template>
              <span v-if="item.reason" class="return-reason">{{ store.t('reason') }}：{{ item.reason }}</span>
            </div>
            <div class="return-item-actions">
              <template v-if="item.status === 'pending'">
                <el-button v-if="item.kind === 'misaligned' && item.suggestedCueId" size="small" type="success" plain @click="acceptSuggestion(record.id, item)">✓ {{ store.t('assignToCue') }}：{{ cueLabel(item.suggestedCueId) }}</el-button>
                <el-select
                  v-if="item.kind !== 'missing'"
                  :model-value="item.cueId"
                  size="small"
                  :placeholder="store.t('selectCueToAssign')"
                  filterable
                  class="return-assign-select"
                  @change="assignItem(record.id, item.id, String($event))"
                >
                  <el-option v-for="cue in project.cues" :key="cue.id" :label="`${formatTime(cue.start)} · ${cue.source.slice(0, 22)}`" :value="cue.id" />
                </el-select>
                <el-button v-if="item.kind === 'missing'" size="small" @click="ackItem(record.id, item.id)">{{ store.t('acknowledge') }}</el-button>
                <el-button v-else size="small" text type="danger" @click="discardItem(record.id, item.id)">{{ store.t('discard') }}</el-button>
              </template>
              <el-tag v-else size="small" :type="returnStatusTagType(item.status)">{{ returnStatusLabel(item.status) }}</el-tag>
            </div>
          </div>
        </div>
      </div>
      <p v-if="!project.studioReturns.length" class="empty-state">{{ store.t('noReturns') }}</p>
      <template #footer><el-button @click="studioDialog = false">{{ store.t('close') }}</el-button></template>
    </el-dialog>
  </div>
</template>
