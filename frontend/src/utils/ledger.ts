/**
 * 台账派生工具：把「安装位（运维班组台账）」与「物理仪器（计量站台账）」
 * 按序列号对齐，并按安装位当前在位数设备重算台站 / 台阵的标定合格率。
 *
 * 核心口径：换机后安装位留着、序列号落到新的一台，历次标定跟着原序列号走；
 * 因此台站卡片与几何页的合格率只统计「安装位当前那台」的标定，
 * 已换下设备的历史标定不再计入当前合格率。
 */
import type { Calibration, ResponseVerdict } from '@/types/calibration';
import type { Installation, Instrument } from '@/types/instrument';
import { round } from '@/utils/geo';

/** 合格判定优先级（用于取历次最差结论） */
const VERDICT_ORDER: Record<ResponseVerdict, number> = { 合格: 0, 待判定: 1, 不合格: 2 };

/** 安装位当前在位数物理仪器（仅认过的安装位参与，认过才算数） */
export function currentDeviceOfInstallation(
  installation: Installation,
  instruments: Instrument[]
): Instrument | undefined {
  if (installation.syncStatus !== '已认') return undefined;
  return instruments.find((ins) => ins.serialNo === installation.serialNo);
}

/** 台站当前在位数设备（按安装位通道排序） */
export function currentDevicesOfStation(
  stationId: string,
  installations: Installation[],
  instruments: Instrument[]
): Instrument[] {
  return installations
    .filter((inst) => inst.stationId === stationId)
    .sort((a, b) => a.channel.localeCompare(b.channel, 'zh-Hans-CN'))
    .map((inst) => currentDeviceOfInstallation(inst, instruments))
    .filter((ins): ins is Instrument => Boolean(ins));
}

/** 台站下的安装位（按通道排序） */
export function installationsOfStation(
  stationId: string,
  installations: Installation[]
): Installation[] {
  return installations
    .filter((inst) => inst.stationId === stationId)
    .sort((a, b) => a.channel.localeCompare(b.channel, 'zh-Hans-CN'));
}

/** 物理仪器的历次标定（按日期降序） */
export function calibrationsOfInstrument(
  instrumentId: string,
  calibrations: Calibration[]
): Calibration[] {
  return calibrations
    .filter((row) => row.instrumentId === instrumentId)
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** 台站当前在位数设备的标定统计（按安装位当前那台重算） */
export function stationCalibrationStats(
  stationId: string,
  installations: Installation[],
  instruments: Instrument[],
  calibrations: Calibration[]
): { total: number; unqualified: number; rate: number; overdue: number } {
  const devices = currentDevicesOfStation(stationId, installations, instruments);
  const deviceIds = new Set(devices.map((ins) => ins.id));
  const rows = calibrations.filter((row) => deviceIds.has(row.instrumentId));
  const unqualified = rows.filter((row) => row.responseVerdict === '不合格').length;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = devices.filter((ins) => ins.qualifyExpiryDate < today).length;
  return {
    total: rows.length,
    unqualified,
    overdue,
    rate: rows.length === 0 ? 0 : round(((rows.length - unqualified) / rows.length) * 100, 1),
  };
}

/** 台阵当前在位数设备的标定统计（按安装位当前那台重算） */
export function arrayCalibrationStats(
  stationIds: string[],
  installations: Installation[],
  instruments: Instrument[],
  calibrations: Calibration[]
): { total: number; unqualified: number; rate: number; overdue: number } {
  const idSet = new Set(stationIds);
  const devices = installations
    .filter((inst) => idSet.has(inst.stationId))
    .map((inst) => currentDeviceOfInstallation(inst, instruments))
    .filter((ins): ins is Instrument => Boolean(ins));
  const deviceIds = new Set(devices.map((ins) => ins.id));
  const rows = calibrations.filter((row) => deviceIds.has(row.instrumentId));
  const unqualified = rows.filter((row) => row.responseVerdict === '不合格').length;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = devices.filter((ins) => ins.qualifyExpiryDate < today).length;
  return {
    total: rows.length,
    unqualified,
    overdue,
    rate: rows.length === 0 ? 0 : round(((rows.length - unqualified) / rows.length) * 100, 1),
  };
}

/** 取一组标定记录中的最差结论 */
export function worstVerdictOf(rows: Calibration[]): ResponseVerdict {
  return rows.reduce<ResponseVerdict>(
    (worst, row) => (VERDICT_ORDER[row.responseVerdict] > VERDICT_ORDER[worst] ? row.responseVerdict : worst),
    '合格'
  );
}

/** 安装位认账状态文案 */
export function syncStatusText(status: Installation['syncStatus']): string {
  return status === '已认' ? '已认' : '待认';
}
