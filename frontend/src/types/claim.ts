/**
 * 序列号挂账：
 * 运维侧安装位填的序列号，在计量站仪器档案里找不到时，先挂到台账里并写清台站；
 * 计量站「认」过（确认/补建物理仪器档案）才算数。认过的结果不退回。
 */

/** 挂账状态：待认领 → 已认领 / 已驳回（认过后不退回） */
export type ClaimState = '待认领' | '已认领' | '已驳回';

export const CLAIM_STATES: ClaimState[] = ['待认领', '已认领', '已驳回'];

/** 挂账来源：安装位序列号无对应档案，或标定记录的序列号无对应档案 */
export type ClaimSource = '安装位' | '标定记录';

export const CLAIM_SOURCES: ClaimSource[] = ['安装位', '标定记录'];

export interface SerialClaim {
  id: string;
  /** 对不上的序列号 */
  serialNo: string;
  /** 挂账来源（安装位 / 标定记录） */
  source: ClaimSource;
  /** 相关安装位（标定记录挂账时可能为空） */
  installId: string | null;
  /** 写清所属台站，便于现场核对 */
  stationId: string | null;
  /** 台站码冗余存一份，台站被删时仍能看出来处 */
  stationCode: string;
  /** 台阵名冗余 */
  arrayName: string;
  /** 挂账说明（如：运维登记了计量站尚无档案的序列号） */
  note: string;
  /** 状态 */
  state: ClaimState;
  /** 认领主键：认过后关联到的物理仪器档案 id（不退回） */
  deviceId: string | null;
  /** 认领说明（计量站补填型号/类型时留痕） */
  resolveNote: string;
  createdAt: number;
  updatedAt: number;
}

/** 挂账页筛选条件 */
export interface ClaimFilterState {
  keyword: string;
  states: ClaimState[];
}

export function createEmptyClaimFilter(): ClaimFilterState {
  return { keyword: '', states: [] };
}
