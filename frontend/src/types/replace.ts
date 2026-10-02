/**
 * 更换（两侧协作）：挂在安装位上。
 * 待更换 → 已更换 → 已复核。
 * 换机时安装位保留、序列号落到新的一台；旧仪器的历次标定仍跟着旧序列号。
 */

/** 更换状态机：待更换 → 已更换 → 已复核 */
export type ReplaceState = '待更换' | '已更换' | '已复核';

export const REPLACE_STATES: ReplaceState[] = ['待更换', '已更换', '已复核'];

/** 状态流转允许的下一步 */
export const REPLACE_TRANSITIONS: Record<ReplaceState, ReplaceState[]> = {
  待更换: ['已更换'],
  已更换: ['已复核', '待更换'],
  已复核: ['待更换'],
};

/** 更换记录：针对某个安装位，把旧序列号换成新序列号 */
export interface Replace {
  id: string;
  /** 发生更换的安装位（运维侧） */
  installId: string;
  /** 换下的旧序列号（其标定历史保留在计量侧，不退回、不改挂） */
  fromSerialNo: string;
  /** 更换原因 */
  reason: string;
  /** 新序列号（更换完成后落到安装位；计量站须先有该序列号档案） */
  newSerialNo: string;
  /** 更换日期 */
  date: string;
  /** 状态 */
  state: ReplaceState;
  /** 责任人 */
  operator: string;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 常用更换原因模板 */
export const REPLACE_REASON_TEMPLATES: Array<{ key: string; reason: string }> = [
  { key: 'noise', reason: '自噪持续超标，标定不合格' },
  { key: 'response', reason: '脉冲响应异常，灵敏度漂移超限' },
  { key: 'damage', reason: '雷击或供电故障导致仪器损坏' },
  { key: 'overdue', reason: '超期未标定，按台网要求整机更换' },
  { key: 'upgrade', reason: '设备升级换代，更换为新型号' },
];

/** 更换页筛选条件 */
export interface ReplaceFilterState {
  keyword: string;
  states: ReplaceState[];
  arrayIds: string[];
}

export function createEmptyReplaceFilter(): ReplaceFilterState {
  return {
    keyword: '',
    states: [],
    arrayIds: [],
  };
}

/** 是否允许状态流转 */
export function canTransition(from: ReplaceState, to: ReplaceState): boolean {
  return (REPLACE_TRANSITIONS[from] ?? []).includes(to);
}
