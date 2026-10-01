import assert from 'node:assert/strict'
import { mergeDocuments, migrateDocument } from '../src/utils/db.ts'
import { parseStudioReturn, reconcile, TIMECODE_TOLERANCE } from '../src/utils/studio.ts'
import type { Cue, EditorDocument } from '../src/types.ts'

const cue = (id: string, patch: Partial<Cue> = {}): Cue => ({
  id, start: 0, end: 4, source: 'S', target: 'T', actorId: 'a1', speed: 1, termIds: [], status: 'draft', locked: false, ...patch,
})

const doc = (revision: number, cues: Cue[], extra: Partial<EditorDocument> = {}): EditorDocument => ({
  id: 'd1', title: 'Doc', language: 'zh-CN', schemaVersion: 2, cues, actors: [], terms: [], snapshots: [],
  studio: { batches: [], pending: [], dismissed: [] }, updatedAt: revision, revision, lastWriter: '', ...extra,
})

let passed = 0
const ok = (name: string) => { passed++; console.log('  ✓', name) }

// 1. 晚保存不覆盖别人：两标签改不同字段，合并后两边改动都在
{
  const base = doc(1, [cue('c1', { target: 'T0', status: 'draft' })])
  const tabA = doc(1, [cue('c1', { target: 'TA', status: 'draft' })]) // A 改译文
  const remote = doc(2, [cue('c1', { target: 'T0', status: 'reviewed' })]) // B 改校对状态
  const { document: merged, conflicts } = mergeDocuments(base, tabA, remote)
  assert.equal(merged.cues[0].target, 'TA', 'A 的译文必须保留')
  assert.equal(merged.cues[0].status, 'reviewed', 'B 的校对状态必须合入')
  assert.equal(conflicts.length, 0)
  ok('不同字段并发：双方改动都保留，互不覆盖')
}

// 2. 同字段两边都改且不一致 → 冲突挂起，不静默覆盖，本地值保留
{
  const base = doc(1, [cue('c1', { target: 'T0' })])
  const tabA = doc(1, [cue('c1', { target: 'TA' })])
  const remote = doc(2, [cue('c1', { target: 'TB' })])
  const { document: merged, conflicts } = mergeDocuments(base, tabA, remote)
  assert.equal(merged.cues[0].target, 'TA')
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].field, 'target')
  ok('同一字段双方各改：挂冲突等人定归属')
}

// 3. 各管各的：配音棚 studio 合入不碰工作台字段；工作台保存不丢 studio
{
  const base = doc(1, [cue('c1', { target: 'T0' })])
  const local = doc(1, [cue('c1', { target: 'T-local' })]) // 本地只改译文
  const remote = doc(2, [cue('c1', {
    target: 'T0',
    studio: { recordedStart: 0, recordedDuration: 3.9, standIn: '替班-王', note: '', updatedAt: 100, batchId: 'b1' },
  })])
  const { document: merged } = mergeDocuments(base, local, remote)
  assert.equal(merged.cues[0].target, 'T-local', '译文归工作台')
  assert.equal(merged.cues[0].studio?.standIn, '替班-王', '替班归配音棚')
  assert.equal(merged.cues[0].studio?.recordedDuration, 3.9)
  ok('实录时长与替班归配音棚，译文/时间码/状态归工作台')
}

// 4. studio 域取较新回传
{
  const older = { recordedStart: 0, recordedDuration: 3.1, standIn: 'old', note: '', updatedAt: 50, batchId: 'b1' }
  const newer = { recordedStart: 0, recordedDuration: 4.2, standIn: 'new', note: '', updatedAt: 200, batchId: 'b2' }
  const base = doc(1, [cue('c1', { studio: older })])
  const local = doc(1, [cue('c1', { studio: older })])
  const remote = doc(2, [cue('c1', { studio: newer })])
  const { document: merged } = mergeDocuments(base, local, remote)
  assert.equal(merged.cues[0].studio?.standIn, 'new')
  ok('同一台词重复回传取较新批次')
}

// 5. 新建台词：A 新建 c2 并保存后，B 基于旧基线保存不应产生误冲突
{
  const base = doc(1, [cue('c1')])
  const remote = doc(2, [...base.cues, cue('c2', { target: 'remote-c2' })]) // A 新建
  const local = doc(1, [cue('c1', { target: 'T-local' }), cue('c3', { target: 'local-c3' })]) // B 改 c1 且自己也新建 c3
  const { document: merged, conflicts } = mergeDocuments(base, local, remote)
  const ids = merged.cues.map((c) => c.id).sort()
  assert.deepEqual(ids, ['c1', 'c2', 'c3'])
  assert.equal(merged.cues.find((c) => c.id === 'c1')!.target, 'T-local')
  assert.equal(merged.cues.find((c) => c.id === 'c2')!.target, 'remote-c2')
  assert.equal(conflicts.length, 0)
  ok('一方新建台词、另一方改其他台词：并存不冲突')
}

// 6. 删除 vs 修改 → 整条冲突挂起，不丢改动
{
  const base = doc(1, [cue('c1', { target: 'T0' }), cue('c2')])
  const local = doc(1, [cue('c1', { target: 'T0' }), cue('c2')]) // 本地未动
  const remote = doc(2, [cue('c1', { target: 'changed' })]) // 远端删了 c2，改了 c1；c2 本地没动→接受删除
  const { document: merged, conflicts } = mergeDocuments(base, local, remote)
  assert.ok(!merged.cues.some((c) => c.id === 'c2'), '双方一致：本地未动、远端删除应接受')
  assert.equal(merged.cues[0].target, 'changed')
  assert.equal(conflicts.length, 0)

  // 本地改了 c2，远端删了 c2（c1 本地未动）→ 只挂 c2 整条冲突
  const local2 = doc(1, [cue('c1', { target: 'T0' }), cue('c2', { target: 'edited' })])
  const r2 = mergeDocuments(base, local2, remote)
  assert.equal(r2.conflicts.length, 1)
  assert.equal(r2.conflicts[0].field, '__cue__')
  assert.ok(r2.document.cues.some((c) => c.id === 'c2'), '被改的台词不能静默删掉')
  assert.equal(r2.document.cues.find((c) => c.id === 'c1')!.target, 'changed', 'c1 本地未动应跟随远端')
  ok('一方删除、另一方修改：挂起整条定归属')
}

// 7. 时间码对账：匹配 / 多出 / 缺少 / 错位
{
  const cues = [
    cue('m1', { start: 0, end: 4 }),
    cue('m2', { start: 4.3, end: 8.6 }),
    cue('m3', { start: 8.8, end: 13.5 }),
    cue('m4a', { start: 13.7, end: 15.5 }),
    cue('m4b', { start: 15.6, end: 18.8 }),
  ]
  const records = [
    { start: 0, duration: 3.9, standIn: '', note: '' },               // 精确匹配 m1
    { start: 4.3 + TIMECODE_TOLERANCE / 2, duration: 4.1, standIn: '', note: '' }, // 容差内 m2
    { start: 13.9, duration: 1.4, standIn: '', note: '' },            // 同时接近 m4a(0.2) / m4b(1.7) 只有一个在窗口
    { start: 40, duration: 3.2, standIn: '替班-李', note: '多的' },     // 多出
  ]
  const { matched, pending } = reconcile(cues, records, 'b1')
  assert.ok(matched.has('m1'))
  assert.ok(matched.has('m2'))
  const reasons = new Map(pending.map((p) => [p.reason, p]))
  assert.ok(reasons.has('extra'), '40s 那条必须挂 extra')
  assert.ok(reasons.has('missing'), '未覆盖台词必须挂 missing（m3）')
  const missingCueIds = pending.filter((p) => p.reason === 'missing').map((p) => p.cueId)
  assert.ok(missingCueIds.includes('m3'))
  ok('按时间码对账：容差内匹配，多出/缺少挂起')

  // 错位：起点落在两条台词窗口交界处
  const crowded = [cue('x1', { start: 10, end: 10.5 }), cue('x2', { start: 10.4, end: 11 })]
  const r = reconcile(crowded, [{ start: 10.2, duration: 0.4, standIn: '', note: '' }], 'b2')
  assert.equal(r.matched.size, 0)
  assert.equal(r.pending[0].reason, 'shifted')
  assert.equal(r.pending[0].suggestionCueId, 'x1')
  ok('一个时间码对上多条：错位挂起并给最近候选')
}

// 8. 回传解析
{
  const text = [
    '# 注释行',
    '00:00:01,500 | 4.25 | 替班-王 | 备注',
    '00:00:06.000\t3.1\t\t',
    '坏行',
  ].join('\n')
  const rows = parseStudioReturn(text)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].record.start, 1.5)
  assert.equal(rows[0].record.duration, 4.25)
  assert.equal(rows[0].record.standIn, '替班-王')
  assert.equal(rows[1].record.start, 6)
  ok('回传文本解析：| 与制表符分隔，忽略注释和坏行')
}

// 9. 旧稿迁移：v1（内联 recordedDuration/standIn，无 schemaVersion）→ v2
{
  const legacy = doc(0, [{ ...cue('c1'), recordedDuration: 4.4, standIn: '老替班', recordedStart: 0.2 } as unknown as Cue])
  delete (legacy as Partial<EditorDocument>).schemaVersion
  delete (legacy as Partial<EditorDocument>).studio
  const migrated = migrateDocument(legacy)
  assert.equal(migrated.schemaVersion, 2)
  assert.equal(migrated.cues[0].studio?.recordedDuration, 4.4)
  assert.equal(migrated.cues[0].studio?.standIn, '老替班')
  assert.ok(migrated.studio)
  ok('旧稿升级：内联实录字段迁移到 studio 域，打开可继续编辑')
}

// 10. dismissed 防重复挂起
{
  const cues = [cue('m1', { start: 0, end: 4 })]
  const r = reconcile(cues, [{ start: 99, duration: 1, standIn: '', note: '' }], 'b1', ['99.000|1.000', 'missing:0.000'])
  assert.equal(r.pending.length, 0)
  assert.equal(r.matched.size, 0)
  ok('已人工忽略的指纹不再重复挂起')
}

console.log(`\n全部 ${passed} 项逻辑验证通过`)
