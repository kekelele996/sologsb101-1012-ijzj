/**
 * 安装位（运维班组维护）：
 * 台账按台站记「安装位、通道、安装日期、当前序列号」。
 * 换机时只改 serialNo，安装位记录保留；历次标定属于物理仪器（按序列号挂在计量侧）。
 */

/** 安装位运行状态（运维侧自行维护） */
export type InstallState = '在用' | '待标定' | '停用';

export const INSTALL_STATES: InstallState[] = ['在用', '待标定', '停用'];

/** 常用观测通道，供表单联想；允许手填其它通道 */
export const COMMON_CHANNELS = ['BHZ', 'BHN', 'BHE', 'HHZ', 'HHN', 'HHE', 'SLZ', 'EPZ'];

/** 旧数据没有通道归属时的兜底值 */
export const LEGACY_CHANNEL = '未登记通道';

/** 安装位：台站上的一个观测通道位置（与物理仪器解耦） */
export interface Install {
  id: string;
  /** 所属台站 */
  stationId: string;
  /** 观测通道，如 BHZ / SLZ */
  channel: string;
  /** 当前安装在该位置的物理仪器序列号（对不上时先进挂账，认过才算数） */
  serialNo: string;
  /** 当前安装日期（本次装机日期） */
  installDate: string;
  /** 运维侧维护的运行状态 */
  state: InstallState;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 安装位登记草稿 */
export interface InstallDraft {
  stationId: string;
  channel: string;
  serialNo: string;
  installDate: string;
  state: InstallState;
  remark: string;
}

export function createEmptyInstallDraft(stationId = ''): InstallDraft {
  return {
    stationId,
    channel: COMMON_CHANNELS[0],
    serialNo: '',
    installDate: new Date().toISOString().slice(0, 10),
    state: '在用',
    remark: '',
  };
}
