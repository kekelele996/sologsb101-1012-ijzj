/**
 * 合格评定派生工具：
 * 台站卡片 / 几何页 / 更换页统一从「安装位当前那台设备」的历次标定计算合格率与超期，
 * 换机后旧序列号的标定不计入安装位所在台站。
 */
import { plusCycle } from '@/types/device';
import type { Install } from '@/types/install';
import type { Calibration, ResponseVerdict } from '@/types/calibration';

export interface InstallQualify {
  install: Install;
  /** 当前序列号那台设备的标定（降序） */
  calibrations: Calibration[];
  latest: Calibration | null;
  count: number;
  /** 最近一次结论（无标定为待判定） */
  verdict: ResponseVerdict;
  /** 是否含不合格标定 */
  hasUnqualified: boolean;
  /** 合格到期日（YYYY-MM-DD 或 null） */
  dueDate: string | null;
  /** 距合格到期天数（负数为超期）；无任何标定时以安装日 + 周期计 */
  dueInDays: number;
  overdue: boolean;
  /** 该安装位是否合格：最近一次标定合格且未超期 */
  qualified: boolean;
}

const DAY_MS = 86400000;

/** 计算单个安装位当前设备的标定评定 */
export function qualifyForInstall(
  install: Install,
  allCalibrations: Calibration[],
  now: number = Date.now()
): InstallQualify {
  const rows = allCalibrations
    .filter((calibration) => calibration.serialNo === install.serialNo)
    .sort((a, b) => b.date.localeCompare(a.date));
  const latest = rows[0] ?? null;
  const latestQualifiedDate = rows.find((row) => row.responseVerdict === '合格')?.date ?? null;
  const dueDate = plusCycle(latestQualifiedDate);
  const baseDate = latestQualifiedDate ?? latest?.date ?? install.installDate;
  const baseTime = Date.parse(`${baseDate}T00:00:00`);
  const dueInDays = Number.isFinite(baseTime)
    ? Math.round((baseTime + 365 * DAY_MS - now) / DAY_MS)
    : Number.NaN;
  const overdue = dueDate !== null && Number.isFinite(dueInDays) && dueInDays < 0;
  const hasUnqualified = rows.some((row) => row.responseVerdict === '不合格');
  return {
    install,
    calibrations: rows,
    latest,
    count: rows.length,
    verdict: latest ? latest.responseVerdict : '待判定',
    hasUnqualified,
    dueDate,
    dueInDays,
    overdue,
    qualified: latest?.responseVerdict === '合格' && !overdue,
  };
}

export interface InstallSetQualifyStat {
  /** 安装位数 */
  total: number;
  /** 当前设备有标定记录的安装位数 */
  withCalibration: number;
  /** 合格安装位数（最近合格且未超期） */
  qualified: number;
  /** 含不合格标定的安装位数 */
  unqualifiedInstalls: number;
  /** 不合格标定条数（当前设备） */
  unqualifiedCalibrations: number;
  /** 超期安装位数 */
  overdue: number;
  /** 合格率 0-100：合格安装位 / 有标定的安装位 */
  qualifyRate: number;
  /** 当前设备标定总条数 */
  calibrationCount: number;
}

/** 一组安装位的合格率汇总（台站卡片、台阵卡片、几何页共用） */
export function qualifyStatForInstalls(
  installs: Install[],
  allCalibrations: Calibration[]
): InstallSetQualifyStat {
  const details = installs.map((install) => qualifyForInstall(install, allCalibrations));
  const withCalibration = details.filter((item) => item.count > 0).length;
  const qualified = details.filter((item) => item.qualified).length;
  const unqualifiedInstalls = details.filter((item) => item.hasUnqualified).length;
  const unqualifiedCalibrations = details.reduce(
    (sum, item) => sum + item.calibrations.filter((row) => row.responseVerdict === '不合格').length,
    0
  );
  const overdue = details.filter((item) => item.overdue).length;
  const calibrationCount = details.reduce((sum, item) => sum + item.count, 0);
  return {
    total: installs.length,
    withCalibration,
    qualified,
    unqualifiedInstalls,
    unqualifiedCalibrations,
    overdue,
    qualifyRate: withCalibration === 0 ? 0 : Math.round((qualified / withCalibration) * 1000) / 10,
    calibrationCount,
  };
}
