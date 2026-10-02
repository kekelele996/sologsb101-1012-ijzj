import 'fake-indexeddb/auto';
import { qualifyStatForInstalls, qualifyForInstall } from '../src/utils/qualify';
import type { Install } from '../src/types/install';
import type { Calibration } from '../src/types/calibration';
import { db, initDatabase } from '../src/utils/db';
import { enqueueEvent, retrySide } from '../src/utils/sync';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error('断言失败: ' + msg);
  console.log('  ✓ ' + msg);
}

async function main() {
  /* ---------- 合格率按安装位当前设备重算 ---------- */
  const now = Date.now();
  const iso = (offsetDays: number) => new Date(now + offsetDays * 86400000).toISOString().slice(0, 10);
  const installs: Install[] = [
    { id: 'i1', stationId: 's', channel: 'BHZ', serialNo: 'OLD', installDate: '2020-01-01', state: '在用', remark: '', createdAt: 0, updatedAt: 0 },
    { id: 'i2', stationId: 's', channel: 'SLZ', serialNo: 'NEW', installDate: iso(-30), state: '在用', remark: '', createdAt: 0, updatedAt: 0 },
  ];
  const calibrations: Calibration[] = [
    // 旧机：曾经合格 + 一次不合格，超期；换机后这些不应计入
    { id: 'c1', serialNo: 'OLD', date: iso(-800), sensitivity: 1500, selfNoise: 1, responseVerdict: '合格', operator: '', agency: '', remark: '', createdAt: 0, updatedAt: 0 },
    { id: 'c2', serialNo: 'OLD', date: iso(-500), sensitivity: 1500, selfNoise: 4.2, responseVerdict: '不合格', operator: '', agency: '', remark: '', createdAt: 0, updatedAt: 0 },
    // 当前新机：近期合格
    { id: 'c3', serialNo: 'NEW', date: iso(-30), sensitivity: 1500, selfNoise: 1.2, responseVerdict: '合格', operator: '', agency: '', remark: '', createdAt: 0, updatedAt: 0 },
  ];

  const stat = qualifyStatForInstalls(installs, calibrations);
  assert(stat.total === 2, '2 个安装位');
  assert(stat.withCalibration === 2, '2 个安装位当前/历史序列号均有标定（OLD 算旧机已拆下场景仍按当前串号查）');
  // i1 当前串号 OLD 仍能查到标定（模拟尚未换机的位），它有不合格且超期
  const q1 = qualifyForInstall(installs[0], calibrations);
  assert(q1.hasUnqualified && q1.overdue, 'i1 当前串号有不合格且超期');
  assert(stat.unqualifiedInstalls === 1 && stat.unqualifiedCalibrations === 1, '不合格只统计当前串号（1 台 / 1 条）');
  assert(stat.qualified === 1, '只有新机所在位合格');
  assert(stat.qualifyRate === 50, '合格率 = 1/2 = 50%');

  // 真正换机场景：i1 序列号也改成 NEW2，旧机标定彻底与台站脱钩
  const afterSwap = qualifyStatForInstalls(
    installs.map((i) => (i.id === 'i1' ? { ...i, serialNo: 'NEW2' } : i)),
    calibrations
  );
  assert(afterSwap.unqualifiedCalibrations === 0 && afterSwap.unqualifiedInstalls === 0, '换机后台站合格率不再受旧机不合格标定影响');
  assert(afterSwap.overdue === 0 || afterSwap.overdue === 1, '换机后无旧标定的位按装机日计到期');

  /* ---------- 同步失败各按本侧重试，认过不退回 ---------- */
  await initDatabase();
  // 手工塞两条 failed 事件，分属两侧；一条 synced+acknowledged
  await db.outbox.bulkPut([
    { id: 'e_ops', side: 'ops', kind: 'serial-pending', serialNo: 'X1', idempotencyKey: 'ops:serial-pending:X1', payload: {}, status: 'failed', attempts: 2, lastError: '网络抖动', acknowledged: false, lastAttemptAt: now, createdAt: now, updatedAt: now },
    { id: 'e_metro', side: 'metro', kind: 'qualify-due', serialNo: 'X2', idempotencyKey: 'metro:qualify-due:X2', payload: {}, status: 'failed', attempts: 1, lastError: '冲突', acknowledged: false, lastAttemptAt: now, createdAt: now, updatedAt: now },
    { id: 'e_done', side: 'ops', kind: 'serial-resolved', serialNo: 'X3', idempotencyKey: 'ops:serial-resolved:X3', payload: {}, status: 'synced', attempts: 1, lastError: '', acknowledged: true, lastAttemptAt: now, createdAt: now, updatedAt: now },
  ]);
  const retriedOps = await retrySide('ops');
  assert(retriedOps === 1, '运维侧重试只捡起本侧 1 条失败事件');
  const metroStillFailed = await db.outbox.get('e_metro');
  assert(metroStillFailed?.status === 'failed', '计量侧失败事件不被运维侧重试带走');
  const opsEvent = await db.outbox.get('e_ops');
  assert(opsEvent?.status === 'synced' && opsEvent.acknowledged, '本侧重试成功后置已同步且认过');
  const doneEvent = await db.outbox.get('e_done');
  assert(doneEvent?.status === 'synced', '认过的事件保持已同步不退回');

  console.log('\n合格率重算与各侧重试断言全部通过 ✅');
  await db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
