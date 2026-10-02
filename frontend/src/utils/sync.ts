/**
 * 两侧对账与同步引擎（纯本地、确定性）。
 *
 * 运维班组维护 installs，计量站维护 devices/calibrations，两边按「序列号」对齐：
 *  - 序列号对不上（运维装了、计量站无档案；或标定序列号无档案）→ 写挂账 claims，并写清台站；
 *  - 计量站认过（补建档案）→ 挂账置「已认领」并发 serial-resolved 事件，认过不退回；
 *  - 同步事件进 outbox，失败后各按本侧重试（retrySide 只重试本侧发出的事件）。
 */
import { ALL_TABLES, createId, db } from '@/utils/db';
import { plusCycle } from '@/types/device';
import type { Device, InstrumentType } from '@/types/device';
import type { SerialClaim } from '@/types/claim';
import type { SyncEvent, SyncKind, SyncSide, SyncStatus } from '@/types/sync';

/** 计算某序列号的合格到期日（最近一次合格标定 + 周期） */
export function qualifyDueOfSerial(
  serialNo: string,
  calibrations: Array<{ serialNo: string; date: string; responseVerdict: string }>
): string | null {
  const latest = calibrations
    .filter((row) => row.serialNo === serialNo && row.responseVerdict === '合格')
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  return latest ? plusCycle(latest.date) : null;
}

/** 标定写入/删除后，重算设备档案的合格到期日与档案状态 */
export async function recomputeDeviceQualify(serialNo: string): Promise<void> {
  const due = qualifyDueOfSerial(serialNo, await db.calibrations.toArray());
  const device = await db.devices.where('serialNo').equals(serialNo).first();
  if (!device) return;
  if (device.qualifyDueDate !== due) {
    await db.devices.update(device.id, { qualifyDueDate: due, updatedAt: Date.now() } as never);
    if (due) await enqueueEvent('metro', 'qualify-due', serialNo, { qualifyDueDate: due });
  }
}

/** 幂等写入同步事件（同 幂等键只留一条；已认过的不重建） */
export async function enqueueEvent(
  side: SyncSide,
  kind: SyncKind,
  serialNo: string,
  payload: Record<string, unknown>
): Promise<void> {
  const idempotencyKey = `${side}:${kind}:${serialNo}`;
  const existing = await db.outbox.where('idempotencyKey').equals(idempotencyKey).first();
  if (existing) {
    // 认过（已同步并标记 acknowledged）的结果不退回
    if (existing.acknowledged && existing.status === 'synced') return;
    if (existing.status === 'pending') return;
    // 失败过 → 允许重新投递重试
    await db.outbox.update(existing.id, {
      status: 'pending',
      payload,
      lastError: '',
      updatedAt: Date.now(),
    } as never);
    return;
  }
  const now = Date.now();
  const event: SyncEvent = {
    id: createId('evt'),
    side,
    kind,
    serialNo,
    idempotencyKey,
    payload,
    status: 'pending',
    attempts: 0,
    lastError: '',
    acknowledged: false,
    lastAttemptAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.outbox.put(event);
}

/**
 * 序列号对账（幂等）：
 * 1) 安装位序列号在设备表无档案 → 待认领挂账（写清台站）；已有档案则自动销账；
 * 2) 标定记录序列号在设备表无档案 → 待认领挂账；
 * 3) 对不上的安装位同步发 serial-pending 事件。
 * 已认过（已认领 / 已驳回）的挂账不退回。
 */
export async function reconcileSerialClaims(): Promise<{ created: number; resolved: number }> {
  const [installs, devices, calibrations, stations, arrays, claims] = await Promise.all([
    db.installs.toArray(),
    db.devices.toArray(),
    db.calibrations.toArray(),
    db.stations.toArray(),
    db.arrays.toArray(),
    db.claims.toArray(),
  ]);
  const deviceSerials = new Set(devices.map((device) => device.serialNo));
  const stationById = new Map(stations.map((station) => [station.id, station]));
  const arrayById = new Map(arrays.map((array) => [array.id, array]));
  const pendingKey = (source: SerialClaim['source'], serialNo: string, installId: string | null) =>
    `${source}:${serialNo}:${installId ?? ''}`;
  const existingPending = new Map(
    claims
      .filter((claim) => claim.state === '待认领')
      .map((claim) => [pendingKey(claim.source, claim.serialNo, claim.installId), claim])
  );

  let created = 0;
  const now = Date.now();
  const stationInfo = (stationId: string | null) => {
    const station = stationId ? stationById.get(stationId) : undefined;
    const array = station ? arrayById.get(station.arrayId) : undefined;
    return { stationCode: station?.code ?? '未知台站', arrayName: array?.name ?? '未知台阵' };
  };

  const openClaim = async (
    source: SerialClaim['source'],
    serialNo: string,
    installId: string | null,
    stationId: string | null,
    note: string
  ): Promise<void> => {
    const key = pendingKey(source, serialNo, installId);
    if (existingPending.has(key)) return;
    const { stationCode, arrayName } = stationInfo(stationId);
    await db.claims.put({
      id: createId('clm'),
      serialNo,
      source,
      installId,
      stationId,
      stationCode,
      arrayName,
      note,
      state: '待认领',
      deviceId: null,
      resolveNote: '',
      createdAt: now,
      updatedAt: now,
    });
    created += 1;
  };

  // 1) 安装位序列号
  await Promise.all(
    installs.map(async (install) => {
      const serial = install.serialNo.trim();
      if (!serial) return;
      if (!deviceSerials.has(serial)) {
        await openClaim('安装位', serial, install.id, install.stationId, '安装位填了计量站尚无档案的序列号');
        await enqueueEvent('ops', 'serial-pending', serial, {
          installId: install.id,
          stationId: install.stationId,
          channel: install.channel,
        });
      }
    })
  );

  // 2) 标定记录序列号（计量站自己这边对不上也先挂账）
  const calibSerials = new Set(calibrations.map((row) => row.serialNo));
  await Promise.all(
    Array.from(calibSerials).map(async (serial) => {
      if (!deviceSerials.has(serial)) {
        const install = installs.find((row) => row.serialNo === serial);
        await openClaim(
          '标定记录',
          serial,
          install?.id ?? null,
          install?.stationId ?? null,
          '标定记录的序列号在物理仪器档案中不存在'
        );
      }
    })
  );

  // 3) 设备档案已补齐 → 自动销掉对应的待认领挂账（认过的不动）
  let resolved = 0;
  await Promise.all(
    claims
      .filter((claim) => claim.state === '待认领' && deviceSerials.has(claim.serialNo))
      .map(async (claim) => {
        const device = devices.find((row) => row.serialNo === claim.serialNo);
        await db.claims.update(claim.id, {
          state: '已认领',
          deviceId: device?.id ?? null,
          resolveNote: '设备档案已补齐，对账自动认领',
          updatedAt: now,
        } as never);
        resolved += 1;
      })
  );

  return { created, resolved };
}

/**
 * 计量站认领挂账：补建/指定物理仪器档案。
 * 认过后不退回；同时发 serial-resolved 给运维侧。
 */
export async function acknowledgeClaim(
  claimId: string,
  input: {
    type: InstrumentType;
    model: string;
    serialNo?: string;
    resolveNote?: string;
  }
): Promise<Device> {
  const claim = await db.claims.get(claimId);
  if (!claim) throw new Error('挂账记录不存在');
  if (claim.state !== '待认领') throw new Error('该挂账已认过，不能重复处理（认过不退回）');

  const serialNo = (input.serialNo ?? claim.serialNo).trim();
  let device = await db.devices.where('serialNo').equals(serialNo).first();
  const now = Date.now();
  if (!device) {
    device = {
      id: createId('dev'),
      type: input.type,
      model: input.model.trim(),
      serialNo,
      qualifyDueDate: qualifyDueOfSerial(serialNo, await db.calibrations.toArray()),
      state: '在用',
      remark: `由挂账「${claim.stationCode}」认领建档`,
      createdAt: now,
      updatedAt: now,
    };
    await db.devices.put(device);
  }

  await db.claims.update(claimId, {
    state: '已认领',
    deviceId: device.id,
    serialNo,
    resolveNote: input.resolveNote ?? '计量站已核对序列号并建档',
    updatedAt: now,
  } as never);

  await enqueueEvent('metro', 'serial-resolved', serialNo, {
    claimId,
    model: device.model,
    type: device.type,
  });
  return device;
}

/** 计量站驳回挂账：序列号确实有误（认过同样不退回） */
export async function rejectClaim(claimId: string, resolveNote: string): Promise<void> {
  const claim = await db.claims.get(claimId);
  if (!claim) throw new Error('挂账记录不存在');
  if (claim.state !== '待认领') throw new Error('该挂账已认过，不能重复处理（认过不退回）');
  await db.claims.update(claimId, {
    state: '已驳回',
    resolveNote: resolveNote || '序列号核对有误，驳回',
    updatedAt: Date.now(),
  } as never);
}

/* ------------------------------ 同步投递 ------------------------------ */

/**
 * 处理一条事件（确定性、幂等）。
 * serial-pending：对侧（计量站）暂无档案时保持待对账，由对账流程建挂账，事件本身投递成功；
 * serial-resolved：对侧（运维）确认安装位序列号已被认可；
 * qualify-due：记录合格到期日更新（安装位视图按需读取设备表）。
 */
function applyEvent(event: SyncEvent): void {
  switch (event.kind) {
    case 'serial-pending':
    case 'serial-resolved':
    case 'qualify-due':
      // 本地对账/读模型负责消费负载；事件投递即认为对侧已收到，无外部失败源
      return;
    default:
      return;
  }
}

/**
 * 推送全部「待同步」事件；failed 事件不在这里被带走——
 * 同步失败后各按本侧重试（retrySide 只把本侧 failed 重置回 pending）。
 */
export async function pumpOutbox(): Promise<{ synced: number; failed: number }> {
  const events = await db.outbox.where('status').equals('pending').toArray();
  let synced = 0;
  let failed = 0;
  await db.transaction('rw', [db.outbox], async () => {
    for (const event of events) {
      const now = Date.now();
      try {
        applyEvent(event);
        await db.outbox.update(event.id, {
          status: 'synced',
          attempts: event.attempts + 1,
          lastError: '',
          lastAttemptAt: now,
          acknowledged: true,
          updatedAt: now,
        } as never);
        synced += 1;
      } catch (error) {
        await db.outbox.update(event.id, {
          status: 'failed',
          attempts: event.attempts + 1,
          lastError: error instanceof Error ? error.message : '同步失败',
          lastAttemptAt: now,
          updatedAt: now,
        } as never);
        failed += 1;
      }
    }
  });
  return { synced, failed };
}

/** 某一侧重试自己发出的失败事件（各按本侧重试） */
export async function retrySide(side: SyncSide): Promise<number> {
  const failed = await db.outbox
    .where('status')
    .equals('failed')
    .and((event: SyncEvent) => event.side === side)
    .toArray();
  const now = Date.now();
  await Promise.all(
    failed.map((event) =>
      db.outbox.update(event.id, { status: 'pending', updatedAt: now } as never)
    )
  );
  if (failed.length > 0) await pumpOutbox();
  return failed.length;
}

/** 手动重试单条事件（只能重试未认过的） */
export async function retryEvent(eventId: string): Promise<void> {
  const event = await db.outbox.get(eventId);
  if (!event) return;
  if (event.acknowledged && event.status === 'synced') return;
  await db.outbox.update(eventId, { status: 'pending', updatedAt: Date.now() } as never);
  await pumpOutbox();
}

/** 供页面一键做完整对账：对账 → 推送 */
export async function runReconciliation(): Promise<{ created: number; resolved: number; synced: number }> {
  const { created, resolved } = await reconcileSerialClaims();
  const { synced } = await pumpOutbox();
  return { created, resolved, synced };
}

/** 一次写多表时的统一事务表清单（供 slice 复用） */
export { ALL_TABLES };
