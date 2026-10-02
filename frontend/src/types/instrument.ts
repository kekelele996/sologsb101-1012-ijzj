/** 仪器类型 */
export type InstrumentType = '宽频带' | '短周期' | '强震';

export const INSTRUMENT_TYPES: InstrumentType[] = ['宽频带', '短周期', '强震'];

/** 仪器状态（物理设备状态） */
export type InstrumentState = '在用' | '待标定' | '已停用';

export const INSTRUMENT_STATES: InstrumentState[] = ['在用', '待标定', '已停用'];

/** 标定周期（天）：超过该天数未标定即视为超期 */
export const CALIBRATION_CYCLE_DAYS = 365;

/**
 * 认账状态：安装位登记的序列号与计量站台账能否对上。
 * - 已认：序列号在计量站台账中存在，双方一致
 * - 待认：序列号对不上，先挂在台账里写清台站，认过才算数
 */
export type SyncStatus = '已认' | '待认';

export const SYNC_STATUS: SyncStatus[] = ['已认', '待认'];

/**
 * 物理仪器（计量站台账）：按序列号记录每台物理设备的型号、历次标定与合格到期日。
 * 序列号是计量站台账的自然键，全局唯一；历次标定跟着序列号走，换机不影响其归属。
 */
export interface Instrument {
  id: string;
  /** 序列号（全局唯一，计量站台账按序列号记账） */
  serialNo: string;
  /** 仪器类型 */
  type: InstrumentType;
  /** 型号 */
  model: string;
  /** 物理设备状态 */
  state: InstrumentState;
  /** 合格到期日（YYYY-MM-DD）：最近一次标定日期 + 标定周期；无标定则按安装日期推算 */
  qualifyExpiryDate: string;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 安装位（运维班组台账）：按台站记录安装位、通道与安装日期。
 * 换机后安装位留着，序列号落到新的一台；安装位本身不随换机删除。
 */
export interface Installation {
  id: string;
  /** 所属台站 */
  stationId: string;
  /** 通道（安装位标识，如 宽频带 / 短周期 / 强震） */
  channel: string;
  /** 当前安装的物理仪器序列号（换机即改写到新序列号） */
  serialNo: string;
  /** 安装日期 */
  installDate: string;
  /** 与计量站台账的认账状态 */
  syncStatus: SyncStatus;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 仪器登记草稿（新建安装位时一并登记物理仪器，存于 instrumentSlice） */
export interface InstrumentDraft {
  stationId: string;
  channel: string;
  type: InstrumentType;
  model: string;
  serialNo: string;
  installDate: string;
  state: InstrumentState;
  remark: string;
}

export function createEmptyInstrumentDraft(): InstrumentDraft {
  return {
    stationId: '',
    channel: '宽频带',
    type: '宽频带',
    model: '',
    serialNo: '',
    installDate: new Date().toISOString().slice(0, 10),
    state: '在用',
    remark: '',
  };
}

/** 换机草稿：在原安装位上换装新序列号 */
export interface SwapDraft {
  installationId: string;
  newSerialNo: string;
  newModel: string;
  date: string;
  reason: string;
  operator: string;
}

export function createEmptySwapDraft(installationId: string): SwapDraft {
  return {
    installationId,
    newSerialNo: '',
    newModel: '',
    date: new Date().toISOString().slice(0, 10),
    reason: '',
    operator: '',
  };
}

/** 常用型号（表单联想用） */
export const COMMON_MODELS: Record<InstrumentType, string[]> = {
  宽频带: ['CMG-3ESPC', 'STS-2.5', 'Trillium-120', 'Trillium-Compact'],
  短周期: ['FSS-3B', 'L-4C-3D', 'CDJ-S2C'],
  强震: ['ES-T', 'CMG-5TDE', 'ETNA2', 'GL-P2B'],
};

/**
 * 计算合格到期日：最近一次标定日期 + 标定周期；无标定则用安装日期 + 标定周期。
 */
export function qualifyExpiryDateOf(
  lastCalibrationDate: string | null,
  installDate: string | null
): string {
  const base = lastCalibrationDate ?? installDate;
  const baseTime = base ? Date.parse(`${base}T00:00:00`) : NaN;
  if (!Number.isFinite(baseTime)) {
    return new Date(Date.now() + CALIBRATION_CYCLE_DAYS * 86400000).toISOString().slice(0, 10);
  }
  return new Date(baseTime + CALIBRATION_CYCLE_DAYS * 86400000).toISOString().slice(0, 10);
}

/**
 * 计算距下次标定的天数：正数表示剩余天数，负数表示已超期天数。
 * 以最近一次标定日期（无标定则用安装日期）为基准。
 */
export function daysUntilDue(lastCalibrationDate: string | null, installDate: string): number {
  const base = lastCalibrationDate ?? installDate;
  const baseTime = Date.parse(`${base}T00:00:00`);
  if (!Number.isFinite(baseTime)) return CALIBRATION_CYCLE_DAYS;
  const dueTime = baseTime + CALIBRATION_CYCLE_DAYS * 86400000;
  const diff = dueTime - Date.now();
  return Math.round(diff / 86400000);
}
