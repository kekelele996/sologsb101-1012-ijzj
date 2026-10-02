/**
 * 物理仪器（计量站维护）：
 * 按序列号记每台物理仪器的型号、历次标定与合格到期日。
 * 仪器在哪个安装位是运维侧的事；换机后标定历史跟着序列号走，不跟着安装位走。
 */

/** 仪器类型 */
export type InstrumentType = '宽频带' | '短周期' | '强震';

export const INSTRUMENT_TYPES: InstrumentType[] = ['宽频带', '短周期', '强震'];

/** 计量侧的仪器档案状态 */
export type DeviceState = '在用' | '库存' | '停用';

export const DEVICE_STATES: DeviceState[] = ['在用', '库存', '停用'];

/** 标定周期（天）：超过该天数未标定即视为超期、合格到期 */
export const CALIBRATION_CYCLE_DAYS = 365;

/** 物理仪器档案：一台真实设备一行，序列号全局唯一 */
export interface Device {
  id: string;
  /** 仪器类型（计量台账分类用） */
  type: InstrumentType;
  /** 型号 */
  model: string;
  /** 序列号（全局唯一，是标定与安装位的关联键） */
  serialNo: string;
  /** 合格到期日：最近一次合格标定日期 + 标定周期；无合格标定时为 null */
  qualifyDueDate: string | null;
  /** 计量侧维护的档案状态 */
  state: DeviceState;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 常用型号（表单联想用） */
export const COMMON_MODELS: Record<InstrumentType, string[]> = {
  宽频带: ['CMG-3ESPC', 'STS-2.5', 'Trillium-120', 'Trillium-Compact'],
  短周期: ['FSS-3B', 'L-4C-3D', 'CDJ-S2C'],
  强震: ['ES-T', 'CMG-5TDE', 'ETNA2', 'GL-P2B'],
};

/**
 * 计算距下次标定的天数：正数表示剩余天数，负数表示已超期天数。
 * 以最近一次合格标定的到期日为准；无合格标定时以给定基准日（通常为安装日期）兜底。
 */
export function daysUntilDue(lastCalibrationDate: string | null, baseDate: string): number {
  const base = lastCalibrationDate ?? baseDate;
  const baseTime = Date.parse(`${base}T00:00:00`);
  if (!Number.isFinite(baseTime)) return CALIBRATION_CYCLE_DAYS;
  const dueTime = baseTime + CALIBRATION_CYCLE_DAYS * 86400000;
  const diff = dueTime - Date.now();
  return Math.round(diff / 86400000);
}

/** 基准日加标定周期，得到合格到期日 */
export function plusCycle(date: string | null): string | null {
  if (!date) return null;
  const time = Date.parse(`${date}T00:00:00`);
  if (!Number.isFinite(time)) return null;
  return new Date(time + CALIBRATION_CYCLE_DAYS * 86400000).toISOString().slice(0, 10);
}
