/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入；
 * 以及按台阵汇总的几何与标定结论（合格率按安装位当前那台设备重算）。
 */
import {
  db,
  DB_NAME,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload,
} from '@/utils/db';
import { plusCycle } from '@/types/device';
import type { ResponseVerdict } from '@/types/calibration';
import { apertureKm, centroid, haversineKm, round, stationDistances } from '@/utils/geo';

/** 备份集合键名 */
export const BACKUP_KEYS = [
  'arrays',
  'stations',
  'installs',
  'devices',
  'calibrations',
  'replaces',
  'claims',
  'outbox',
] as const;
export type BackupKey = (typeof BACKUP_KEYS)[number];

export type CountMap = Record<BackupKey, number>;

const EMPTY_COUNTS: CountMap = {
  arrays: 0,
  stations: 0,
  installs: 0,
  devices: 0,
  calibrations: 0,
  replaces: 0,
  claims: 0,
  outbox: 0,
};

/** 组装当前本地数据的完整快照 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [arrays, stations, installs, devices, calibrations, replaces, claims, outbox] = await Promise.all([
    db.arrays.toArray(),
    db.stations.toArray(),
    db.installs.toArray(),
    db.devices.toArray(),
    db.calibrations.toArray(),
    db.replaces.toArray(),
    db.claims.toArray(),
    db.outbox.toArray(),
  ]);
  return {
    app: 'gbseisarray',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    arrays,
    stations,
    installs,
    devices,
    calibrations,
    replaces,
    claims,
    outbox,
  };
}

/** 校验外部 JSON 是否为本站可识别的备份文件 */
export function validateBackup(input: unknown): {
  ok: boolean;
  errors: string[];
  payload: BackupPayload | null;
} {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null };
  }
  const obj = input as Partial<BackupPayload>;
  if (obj.app !== undefined && obj.app !== 'gbseisarray') {
    errors.push('app 字段应为 gbseisarray，文件来源不明');
  }
  for (const key of BACKUP_KEYS) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`);
  }
  if (errors.length > 0) return { ok: false, errors, payload: null };
  const payload: BackupPayload = {
    app: 'gbseisarray',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    arrays: obj.arrays ?? [],
    stations: obj.stations ?? [],
    installs: obj.installs ?? [],
    devices: obj.devices ?? [],
    calibrations: obj.calibrations ?? [],
    replaces: obj.replaces ?? [],
    claims: obj.claims ?? [],
    outbox: obj.outbox ?? [],
  };
  return { ok: true, errors, payload };
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    ...EMPTY_COUNTS,
    arrays: payload.arrays.length,
    stations: payload.stations.length,
    installs: payload.installs.length,
    devices: payload.devices.length,
    calibrations: payload.calibrations.length,
    replaces: payload.replaces.length,
    claims: payload.claims.length,
    outbox: payload.outbox.length,
  };
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: CountMap }> {
  const payload = await buildBackupPayload();
  const fileName = `${DB_NAME}-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
  stampBackupTime(payload.exportedAt);
  return { fileName, counts: countPayload(payload) };
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(file, 'utf-8');
  });
}

/** 导入快照：overwrite=true 先清空全部表，否则按主键合并 */
export async function importBackup(payload: BackupPayload, overwrite: boolean): Promise<CountMap> {
  if (overwrite) await clearAllTables();
  await db.transaction(
    'rw',
    [
      db.arrays,
      db.stations,
      db.installs,
      db.devices,
      db.calibrations,
      db.replaces,
      db.claims,
      db.outbox,
    ],
    async () => {
      await db.arrays.bulkPut(payload.arrays);
      await db.stations.bulkPut(payload.stations);
      await db.installs.bulkPut(payload.installs);
      await db.devices.bulkPut(payload.devices);
      await db.calibrations.bulkPut(payload.calibrations);
      await db.replaces.bulkPut(payload.replaces);
      await db.claims.bulkPut(payload.claims);
      await db.outbox.bulkPut(payload.outbox);
    }
  );
  return countPayload(payload);
}

/**
 * 追加式导入：为运维侧实体（台阵/台站/安装位/更换/挂账）重新分配 id；
 * 序列号是两侧对账的业务键，保持不变；标定按序列号挂，也保持序列号不变。
 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const arrayMap = new Map<string, string>();
  const stationMap = new Map<string, string>();
  const installMap = new Map<string, string>();

  const arrays = payload.arrays.map((row) => {
    const id = createId('arr');
    arrayMap.set(row.id, id);
    return { ...row, id };
  });
  const stations = payload.stations.map((row) => {
    const id = createId('stn');
    stationMap.set(row.id, id);
    return { ...row, id, arrayId: arrayMap.get(row.arrayId) ?? row.arrayId };
  });
  const installs = payload.installs.map((row) => {
    const id = createId('ins');
    installMap.set(row.id, id);
    return { ...row, id, stationId: stationMap.get(row.stationId) ?? row.stationId };
  });
  // 物理仪器 / 标定按序列号是业务键，只重发主键，序列号不动
  const devices = payload.devices.map((row) => ({ ...row, id: createId('dev') }));
  const calibrations = payload.calibrations.map((row) => ({ ...row, id: createId('cal') }));
  const replaces = payload.replaces.map((row) => ({
    ...row,
    id: createId('rpl'),
    installId: installMap.get(row.installId) ?? row.installId,
  }));
  const claims = payload.claims.map((row) => ({
    ...row,
    id: createId('clm'),
    installId: row.installId ? installMap.get(row.installId) ?? row.installId : null,
    stationId: row.stationId ? stationMap.get(row.stationId) ?? row.stationId : null,
    deviceId: null,
  }));
  const outbox = payload.outbox.map((row) => ({ ...row, id: createId('evt') }));
  return { ...payload, arrays, stations, installs, devices, calibrations, replaces, claims, outbox };
}

/** 按台阵汇总的几何与标定结论 */
export interface ArrayGeometrySummary {
  arrayId: string;
  arrayName: string;
  state: string;
  department: string;
  deployDate: string;
  recordedApertureKm: number;
  computedApertureKm: number;
  stationCount: number;
  installCount: number;
  center: { lat: number; lng: number } | null;
  maxPair: { fromCode: string; toCode: string; km: number } | null;
  minSpacingKm: number;
  meanSpacingKm: number;
  /** 安装位当前设备的标定次数（换机后只算当前那台） */
  calibrationCount: number;
  /** 当前设备不合格标定次数 */
  unqualifiedCount: number;
  /** 当前设备的安装位合格率（0-100）：合格安装位 / 有标定的安装位 */
  qualifyRate: number;
  overdueCount: number;
  pendingReplaceCount: number;
  pendingClaimCount: number;
  conclusion: string;
}

/**
 * 由快照计算台阵几何与标定结论。
 * 合格率、超期一律按安装位「当前那台」设备的标定重算；换机后旧机历次标定不计入台站。
 */
export function buildArraySummaries(payload: BackupPayload): ArrayGeometrySummary[] {
  const now = Date.now();
  return payload.arrays.map((array) => {
    const stations = payload.stations.filter((station) => station.arrayId === array.id);
    const stationIds = new Set(stations.map((station) => station.id));
    const installs = payload.installs.filter((install) => stationIds.has(install.stationId));
    const currentSerials = new Set(installs.map((install) => install.serialNo));
    const calibrations = payload.calibrations.filter((calibration) =>
      currentSerials.has(calibration.serialNo)
    );
    const installIds = new Set(installs.map((install) => install.id));
    const replaces = payload.replaces.filter((replace) => installIds.has(replace.installId));
    const claims = payload.claims.filter(
      (claim) => claim.stationId && stationIds.has(claim.stationId) && claim.state === '待认领'
    );

    const points = stations.map((station) => ({
      id: station.id,
      code: station.code,
      lat: station.lat,
      lng: station.lng,
    }));
    const distances = stationDistances(points);
    const computed = apertureKm(points);
    const center = centroid(points);
    const minSpacingKm = distances.length === 0 ? 0 : distances[distances.length - 1].km;
    const meanSpacingKm =
      distances.length === 0
        ? 0
        : round(distances.reduce((sum, row) => sum + row.km, 0) / distances.length, 3);

    /** 每个安装位只看当前序列号那台设备的标定 */
    let unqualifiedCount = 0;
    let overdueCount = 0;
    let qualifiedInstalls = 0;
    let installsWithCalibration = 0;
    installs.forEach((install) => {
      const own = calibrations
        .filter((calibration) => calibration.serialNo === install.serialNo)
        .sort((a, b) => b.date.localeCompare(a.date));
      const latest = own[0];
      if (own.length > 0) {
        installsWithCalibration += 1;
        if (own.some((row) => row.responseVerdict === '不合格')) unqualifiedCount += 1;
        if (latest && latest.responseVerdict === '合格') qualifiedInstalls += 1;
      }
      const lastQualified = own.find((row) => row.responseVerdict === '合格')?.date ?? null;
      const due = plusCycle(lastQualified);
      const lastDate = latest?.date ?? install.installDate;
      const lastTime = Date.parse(`${lastDate}T00:00:00`);
      if (!Number.isFinite(lastTime) || (due ? Date.parse(`${due}T00:00:00`) < now : false)) {
        overdueCount += 1;
      }
    });
    const qualifyRate =
      installsWithCalibration === 0
        ? 0
        : round((qualifiedInstalls / installsWithCalibration) * 100, 1);
    const pendingReplaceCount = replaces.filter((replace) => replace.state !== '已复核').length;
    const pendingClaimCount = claims.length;

    const conclusionParts: string[] = [
      `${stations.length} 个台站、${installs.length} 个安装位`,
      `实算孔径 ${computed} km`,
      `当前设备累计 ${calibrations.length} 次标定`,
      `合格率 ${qualifyRate}%`,
    ];
    if (unqualifiedCount > 0) conclusionParts.push(`${unqualifiedCount} 个安装位当前设备有不合格标定`);
    if (overdueCount > 0) conclusionParts.push(`${overdueCount} 个安装位超期未标定`);
    if (pendingReplaceCount > 0) conclusionParts.push(`${pendingReplaceCount} 条更换未闭环`);
    if (pendingClaimCount > 0) conclusionParts.push(`${pendingClaimCount} 个序列号待认领`);

    return {
      arrayId: array.id,
      arrayName: array.name,
      state: array.state,
      department: array.department,
      deployDate: array.deployDate,
      recordedApertureKm: array.apertureKm,
      computedApertureKm: computed,
      stationCount: stations.length,
      installCount: installs.length,
      center,
      maxPair:
        distances.length === 0
          ? null
          : {
              fromCode: distances[0].fromCode,
              toCode: distances[0].toCode,
              km: distances[0].km,
            },
      minSpacingKm,
      meanSpacingKm,
      calibrationCount: calibrations.length,
      unqualifiedCount,
      qualifyRate,
      overdueCount,
      pendingReplaceCount,
      pendingClaimCount,
      conclusion: conclusionParts.join('，'),
    };
  });
}

/** 判定结论统计 */
export function verdictCounts(calibrations: Array<{ responseVerdict: ResponseVerdict }>): Record<
  ResponseVerdict,
  number
> {
  const counts: Record<ResponseVerdict, number> = { 合格: 0, 不合格: 0, 待判定: 0 };
  calibrations.forEach((calibration) => {
    counts[calibration.responseVerdict] += 1;
  });
  return counts;
}

/** 样例：台站与台阵中心的最远距离（km），用于几何页展示各台站辐射距离 */
export function stationRadialDistances(
  points: Array<{ id: string; code: string; lat: number; lng: number }>,
  center: { lat: number; lng: number } | null
): Array<{ id: string; code: string; km: number }> {
  if (!center) return [];
  return points
    .map((point) => ({ id: point.id, code: point.code, km: haversineKm(center, point) }))
    .sort((a, b) => b.km - a.km);
}
