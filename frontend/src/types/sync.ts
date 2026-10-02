/**
 * 两侧同步：运维班组（ops）与计量站（metro）各自维护自己那份台账，
 * 通过序列号对账事件同步。同步失败后各按本侧重试（只重试自己发出的事件），
 * 已经认过（synced / 已认领）的结果不退回。
 */

/** 同步方向：谁同步给谁 */
export type SyncSide = 'ops' | 'metro';

export const SYNC_SIDE_LABEL: Record<SyncSide, string> = {
  ops: '运维班组',
  metro: '计量站',
};

/** 事件类型 */
export type SyncKind =
  /** 运维 → 计量：某安装位用了一个计量站尚无档案的序列号（发起挂账） */
  | 'serial-pending'
  /** 计量 → 运维：序列号已被计量站认领，安装位可以生效 */
  | 'serial-resolved'
  /** 计量 → 运维：仪器合格到期日更新（换机/标定后） */
  | 'qualify-due';

export const SYNC_KIND_LABEL: Record<SyncKind, string> = {
  'serial-pending': '序列号待认领',
  'serial-resolved': '序列号已认领',
  'qualify-due': '合格到期日更新',
};

/** 事件状态 */
export type SyncStatus = 'pending' | 'synced' | 'failed';

export const SYNC_STATUS_LABEL: Record<SyncStatus, string> = {
  pending: '待同步',
  synced: '已同步',
  failed: '同步失败',
};

export interface SyncEvent {
  id: string;
  /** 发起侧 */
  side: SyncSide;
  kind: SyncKind;
  /** 关联序列号 */
  serialNo: string;
  /** 幂等键：同 (side, kind, serialNo) 只保留一条待处理事件 */
  idempotencyKey: string;
  /** 事件负载（台站信息 / 到期日等） */
  payload: Record<string, unknown>;
  status: SyncStatus;
  /** 已尝试次数 */
  attempts: number;
  /** 最近一次失败原因 */
  lastError: string;
  /** 认过的结果不退回：一旦置位，事件永不回退为 pending */
  acknowledged: boolean;
  lastAttemptAt: number | null;
  createdAt: number;
  updatedAt: number;
}
