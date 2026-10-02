/**
 * useCalibHistory：按物理仪器序列号聚合历次标定、算灵敏度变化量与合格到期天数。
 * 台站 / 台阵经「当前装在哪个安装位」取得；换机后历史只跟序列号走，不跟安装位。
 * 被标定记录台（/calibrations）与更换提醒页（/replacements）消费。
 */
import { useCallback, useMemo } from 'react';
import { useSelector } from 'react-redux';
import { selectArrays, selectStations } from '@/stores/arraySlice';
import { selectInstalls } from '@/stores/installSlice';
import { selectDevices } from '@/stores/deviceSlice';
import { selectCalibrations } from '@/stores/calibrationSlice';
import { calibrateDueText, sensitivityDelta, type SensitivityDelta } from '@/types/calibration';
import { CALIBRATION_CYCLE_DAYS, daysUntilDue, plusCycle, type Device } from '@/types/device';
import type { Calibration, ResponseVerdict } from '@/types/calibration';

/** 单台物理仪器的标定历史聚合 */
export interface DeviceCalibHistory {
  device: Device;
  /** 当前安装位 id（可能为空：库存/已拆下） */
  installId: string | null;
  stationCode: string;
  arrayId: string;
  arrayName: string;
  /** 历次标定（按日期降序） */
  calibrations: Calibration[];
  latest: Calibration | null;
  delta: SensitivityDelta;
  count: number;
  /** 距合格到期天数（负数为已超期） */
  dueInDays: number;
  overdue: boolean;
  /** 是否待标定：无合格标定、超期或最近一次不合格 */
  pending: boolean;
  worstVerdict: ResponseVerdict;
  trend: Array<{ date: string; sensitivity: number; selfNoise: number }>;
}

export interface UseCalibHistoryResult {
  histories: DeviceCalibHistory[];
  historyOf: (serialNo: string) => DeviceCalibHistory | null;
  overdueHistories: DeviceCalibHistory[];
  trendOf: (serialNo: string) => Array<{ date: string; sensitivity: number; selfNoise: number }>;
}

const VERDICT_ORDER: Record<ResponseVerdict, number> = { 合格: 0, 待判定: 1, 不合格: 2 };

export function useCalibHistory(): UseCalibHistoryResult {
  const arrays = useSelector(selectArrays);
  const stations = useSelector(selectStations);
  const installs = useSelector(selectInstalls);
  const devices = useSelector(selectDevices);
  const calibrations = useSelector(selectCalibrations);

  const histories = useMemo<DeviceCalibHistory[]>(() => {
    // 序列号 → 当前安装位
    const installBySerial = new Map(installs.map((install) => [install.serialNo, install]));

    return devices
      .map((device) => {
        const install = installBySerial.get(device.serialNo) ?? null;
        const station = install ? stations.find((item) => item.id === install.stationId) : undefined;
        const array = station ? arrays.find((item) => item.id === station.arrayId) : undefined;
        const rows = calibrations
          .filter((calibration) => calibration.serialNo === device.serialNo)
          .sort((a, b) => b.date.localeCompare(a.date));
        const latest = rows.length > 0 ? rows[0] : null;
        const previous = rows.length > 1 ? rows[1] : null;
        const delta = sensitivityDelta(latest?.sensitivity ?? 0, previous ? previous.sensitivity : null);
        const latestQualifiedDate = rows.find((row) => row.responseVerdict === '合格')?.date ?? null;
        const dueDate = plusCycle(latestQualifiedDate);
        // 基准日：当前安装日期；库存设备没有安装位时取建档兜底（daysUntilDue 内处理）
        const baseDate = install?.installDate ?? (rows.length > 0 ? rows[rows.length - 1].date : '');
        const dueInDays = daysUntilDue(latestQualifiedDate, baseDate);
        const worstVerdict = rows.reduce<ResponseVerdict>((worst, row) => {
          return VERDICT_ORDER[row.responseVerdict] > VERDICT_ORDER[worst] ? row.responseVerdict : worst;
        }, '合格');
        return {
          device,
          installId: install?.id ?? null,
          stationCode: station?.code ?? (install ? '未知台站' : '库存 / 已拆下'),
          arrayId: array?.id ?? station?.arrayId ?? '',
          arrayName: array?.name ?? '未安装',
          calibrations: rows,
          latest,
          delta,
          count: rows.length,
          dueInDays,
          overdue: dueDate !== null && dueInDays < 0,
          pending: rows.length === 0 || dueInDays < 0 || (latest?.responseVerdict ?? '待判定') !== '合格',
          worstVerdict,
          trend: [...rows]
            .reverse()
            .map((row) => ({ date: row.date, sensitivity: row.sensitivity, selfNoise: row.selfNoise })),
        };
      })
      .sort((a, b) => a.dueInDays - b.dueInDays);
  }, [arrays, calibrations, devices, installs, stations]);

  const historyOf = useCallback(
    (serialNo: string): DeviceCalibHistory | null =>
      histories.find((history) => history.device.serialNo === serialNo) ?? null,
    [histories]
  );

  const overdueHistories = useMemo(
    () => histories.filter((history) => history.overdue || history.pending),
    [histories]
  );

  const trendOf = useCallback(
    (serialNo: string): Array<{ date: string; sensitivity: number; selfNoise: number }> =>
      histories.find((history) => history.device.serialNo === serialNo)?.trend ?? [],
    [histories]
  );

  return { histories, historyOf, overdueHistories, trendOf };
}

/** 标定周期说明文案，供页面提示 */
export const CALIBRATION_CYCLE_TEXT = `标定周期 ${CALIBRATION_CYCLE_DAYS} 天（约 1 年），合格到期未标定即超期高亮`;

/** 待标定天数文案 */
export function dueText(history: DeviceCalibHistory): string {
  return calibrateDueText(history.dueInDays);
}
