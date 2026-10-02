/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbseisarray，含数据结构版本号与升级迁移逻辑
 * - v3：把「仪器 + 安装位」拆成两份台账
 *   · instruments（计量站台账）：按序列号记物理仪器的型号、历次标定与合格到期日
 *   · installations（运维班组台账）：按台站记安装位、通道与安装日期
 *   换机后安装位留着、序列号落到新的一台，历次标定跟着原序列号走。
 * - 首次打开自动播种互相引用的演示数据（台阵 → 台站 → 安装位 / 物理仪器 → 标定 / 更换）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie';
import type { SeisArray } from '@/types/array';
import type { SeisStation } from '@/types/station';
import {
  qualifyExpiryDateOf,
  type Installation,
  type Instrument,
  type InstrumentState,
  type InstrumentType,
} from '@/types/instrument';
import { judgeCalibration } from '@/types/calibration';
import type { Calibration } from '@/types/calibration';
import type { Replace, ReplaceState } from '@/types/replace';

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3;

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbseisarray';

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbseisarray:db-version',
  lastBackupAt: 'gbseisarray:last-backup-at',
  lastArrayId: 'gbseisarray:last-array-id',
} as const;

/** 备份文件结构，供 utils/export.ts 与几何页使用 */
export interface BackupPayload {
  app: 'gbseisarray';
  dbVersion: number;
  exportedAt: string;
  arrays: SeisArray[];
  stations: SeisStation[];
  instruments: Instrument[];
  installations: Installation[];
  calibrations: Calibration[];
  replaces: Replace[];
}

export class SeisArrayDatabase extends Dexie {
  arrays!: Table<SeisArray, string>;
  stations!: Table<SeisStation, string>;
  instruments!: Table<Instrument, string>;
  installations!: Table<Installation, string>;
  calibrations!: Table<Calibration, string>;
  replaces!: Table<Replace, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      arrays: 'id, name, state',
      stations: 'id, arrayId, code',
      instruments: 'id, stationId, serialNo, state',
      calibrations: 'id, instrumentId, date',
      replaces: 'id, instrumentId, state',
    });

    // v2：补齐筛选与统计需要的索引
    this.version(2).stores({
      arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
      stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
      instruments: 'id, stationId, type, model, serialNo, installDate, state, updatedAt',
      calibrations: 'id, instrumentId, date, sensitivity, selfNoise, responseVerdict, updatedAt',
      replaces: 'id, instrumentId, state, date, newSerialNo, updatedAt',
    });

    // v3：拆分为物理仪器（计量站台账）与安装位（运维班组台账）
    this.version(DB_VERSION)
      .stores({
        arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
        stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
        instruments: 'id, serialNo, type, model, state, qualifyExpiryDate, updatedAt',
        installations: 'id, stationId, channel, serialNo, installDate, syncStatus, updatedAt',
        calibrations: 'id, instrumentId, date, sensitivity, selfNoise, responseVerdict, updatedAt',
        replaces: 'id, installationId, state, date, newSerialNo, updatedAt',
      })
      .upgrade(async (tx) => {
        const now = Date.now();

        // 1) 物理仪器：去掉 stationId / installDate，补合格到期日与序列号
        const oldInstruments = await tx.table('instruments').toArray();
        const installationIdByInstrumentId = new Map<string, string>();
        for (const old of oldInstruments) {
          const serialNo =
            typeof old.serialNo === 'string' && old.serialNo.trim().length > 0
              ? old.serialNo.trim()
              : `待补-${String(old.id).slice(-6)}`;
          const oldCalibs = await tx
            .table('calibrations')
            .where('instrumentId')
            .equals(old.id)
            .toArray();
          const lastDate = oldCalibs.map((c) => c.date as string).sort().pop() ?? null;
          const qualifyExpiryDate = qualifyExpiryDateOf(lastDate, old.installDate as string);
          await tx.table('instruments').put({
            id: old.id,
            serialNo,
            type: (old.type as InstrumentType) ?? '宽频带',
            model: (old.model as string) ?? '',
            state: (old.state as InstrumentState) ?? '在用',
            qualifyExpiryDate,
            remark: (old.remark as string) ?? '',
            createdAt: typeof old.createdAt === 'number' ? old.createdAt : now,
            updatedAt: now,
          });

          // 2) 安装位：由旧仪器的台站 + 安装日期迁移而来，通道沿用类型
          const instId = createId('inst');
          installationIdByInstrumentId.set(old.id, instId);
          await tx.table('installations').put({
            id: instId,
            stationId: old.stationId as string,
            channel: (old.type as string) ?? '宽频带',
            serialNo,
            installDate: (old.installDate as string) ?? new Date(now).toISOString().slice(0, 10),
            syncStatus: '已认',
            remark: '',
            createdAt: typeof old.createdAt === 'number' ? old.createdAt : now,
            updatedAt: now,
          });
        }

        // 3) 更换记录：instrumentId → installationId，并补原序列号
        const oldReplaces = await tx.table('replaces').toArray();
        for (const r of oldReplaces) {
          const installationId = installationIdByInstrumentId.get(r.instrumentId as string);
          const inst = installationId
            ? await tx.table('installations').get(installationId)
            : undefined;
          await tx.table('replaces').put({
            id: r.id,
            installationId: installationId ?? (r.instrumentId as string),
            reason: (r.reason as string) ?? '',
            oldSerialNo: (inst?.serialNo as string) ?? '',
            newSerialNo: (r.newSerialNo as string) ?? '',
            date: (r.date as string) ?? new Date(now).toISOString().slice(0, 10),
            state: (r.state as ReplaceState) ?? '待更换',
            operator: (r.operator as string) ?? '',
            remark: (r.remark as string) ?? '',
            createdAt: typeof r.createdAt === 'number' ? r.createdAt : now,
            updatedAt: now,
          });
        }
      });
  }
}

export const db = new SeisArrayDatabase();

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 由序列号生成物理仪器主键（确定性，便于播种与对账） */
export function instrumentIdOf(serialNo: string): string {
  return `ins_${serialNo.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

/** 订阅单表变化（Dexie liveQuery），返回取消订阅函数 */
export function watchTable<T>(
  table: () => Table<T, string>
): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray());
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([]),
      });
      return () => subscription.unsubscribe();
    },
  };
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedCalibration {
  id: string;
  date: string;
  sensitivity: number;
  selfNoise: number;
  operator: string;
  agency: string;
  remark: string;
}

interface SeedDevice {
  serialNo: string;
  type: InstrumentType;
  model: string;
  state: InstrumentState;
  remark: string;
  calibrations: SeedCalibration[];
}

interface SeedSwap {
  device: SeedDevice;
  replacedAt: string;
  reason: string;
  replaceState: ReplaceState;
  replaceId: string;
}

interface SeedInstallation {
  id: string;
  channel: string;
  current: SeedDevice;
  installDate: string;
  remark: string;
  swappedOut?: SeedSwap[];
}

interface SeedStation {
  id: string;
  arrayId: string;
  code: string;
  lat: number;
  lng: number;
  elevM: number;
  bedrock: SeisStation['bedrock'];
  siteNote: string;
  installations: SeedInstallation[];
}

interface SeedArray {
  id: string;
  name: string;
  apertureKm: number;
  deployDate: string;
  state: SeisArray['state'];
  department: string;
  stations: SeedStation[];
}

/**
 * 播种演示数据：2 个台阵 → 5 个台站 → 安装位 / 物理仪器 → 14 条标定 + 3 条更换。
 * 覆盖「在用 / 待标定 / 已停用」与「合格 / 不合格」以及换机场景：
 * 龙门峡 LTX01 宽频带安装位已换过机（旧设备 2 次标定后跟原序列号走、新设备在位数）。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const daysAgo = (days: number): string => new Date(now - days * 86400000).toISOString().slice(0, 10);

  const arrays: SeedArray[] = [
    {
      id: 'arr_ltx',
      name: '龙门峡流动台阵',
      apertureKm: 24.6,
      deployDate: '2021-04-18',
      state: '运行中',
      department: '省地震局监测中心',
      stations: [
        {
          id: 'stn_ltx_01',
          arrayId: 'arr_ltx',
          code: 'LTX01',
          lat: 30.8421,
          lng: 103.5624,
          elevM: 1180,
          bedrock: '花岗岩',
          siteNote: '基岩出露，噪声本底低',
          installations: [
            {
              id: 'inst_ltx01_bb',
              channel: '宽频带',
              installDate: '2024-05-20',
              remark: '主用宽频带，配 24 位采集器；2024 年整机更换',
              current: {
                serialNo: 'CMG-3E-20240520-99',
                type: '宽频带',
                model: 'CMG-3ESPC',
                state: '在用',
                remark: '换机后新安装的宽频带',
                calibrations: [],
              },
              swappedOut: [
                {
                  device: {
                    serialNo: 'CMG-3E-20210418-01',
                    type: '宽频带',
                    model: 'CMG-3ESPC',
                    state: '已停用',
                    remark: '2024 年换机拆下，历次标定跟原序列号走',
                    calibrations: [
                      {
                        id: 'cal_ltx01_bb_1',
                        date: '2023-04-20',
                        sensitivity: 1502.4,
                        selfNoise: 1.82,
                        operator: '陈立群',
                        agency: '省地震局计量站',
                        remark: '响应曲线平滑',
                      },
                      {
                        id: 'cal_ltx01_bb_2',
                        date: '2024-04-12',
                        sensitivity: 1468.9,
                        selfNoise: 1.95,
                        operator: '陈立群',
                        agency: '省地震局计量站',
                        remark: '灵敏度略降 2.2%，仍在限内',
                      },
                    ],
                  },
                  replacedAt: daysAgo(60),
                  reason: '超期未标定，更换为新型号',
                  replaceState: '已复核',
                  replaceId: 'rpl_ltx01_bb',
                },
              ],
            },
            {
              id: 'inst_ltx01_st',
              channel: '短周期',
              installDate: '2021-04-18',
              remark: '备份仪器，已逾标定周期',
              current: {
                serialNo: 'FSS3B-20210418-02',
                type: '短周期',
                model: 'FSS-3B',
                state: '待标定',
                remark: '',
                calibrations: [
                  {
                    id: 'cal_ltx01_st_1',
                    date: '2022-05-06',
                    sensitivity: 412.6,
                    selfNoise: 2.4,
                    operator: '周渝',
                    agency: '省地震局计量站',
                    remark: '首次标定',
                  },
                ],
              },
            },
          ],
        },
        {
          id: 'stn_ltx_02',
          arrayId: 'arr_ltx',
          code: 'LTX02',
          lat: 30.9187,
          lng: 103.6412,
          elevM: 1425,
          bedrock: '玄武岩',
          siteNote: '半山台基，交通便利',
          installations: [
            {
              id: 'inst_ltx02_bb',
              channel: '宽频带',
              installDate: '2022-03-15',
              remark: '井下安装，深度 42 m',
              current: {
                serialNo: 'T120-20220315-07',
                type: '宽频带',
                model: 'Trillium-120',
                state: '在用',
                remark: '',
                calibrations: [
                  {
                    id: 'cal_ltx02_bb_1',
                    date: '2024-03-18',
                    sensitivity: 1204.8,
                    selfNoise: 1.42,
                    operator: '林之遥',
                    agency: '省地震局计量站',
                    remark: '响应一致性良好',
                  },
                ],
              },
            },
            {
              id: 'inst_ltx02_st',
              channel: '短周期',
              installDate: '2022-03-15',
              remark: '2024 年雷击损坏，已提交更换',
              current: {
                serialNo: 'L4C-20220315-08',
                type: '短周期',
                model: 'L-4C-3D',
                state: '已停用',
                remark: '雷击损坏，待更换',
                calibrations: [
                  {
                    id: 'cal_ltx02_st_1',
                    date: '2023-03-10',
                    sensitivity: 265.2,
                    selfNoise: 4.8,
                    operator: '周渝',
                    agency: '省地震局计量站',
                    remark: '自噪超标，判定不合格',
                  },
                ],
              },
            },
          ],
        },
        {
          id: 'stn_ltx_03',
          arrayId: 'arr_ltx',
          code: 'LTX03',
          lat: 30.7802,
          lng: 103.4987,
          elevM: 986,
          bedrock: '石灰岩',
          siteNote: '河谷阶地，需注意汛期供电',
          installations: [
            {
              id: 'inst_ltx03_bb',
              channel: '宽频带',
              installDate: '2023-09-02',
              remark: '新建站首台仪器',
              current: {
                serialNo: 'STS25-20230902-11',
                type: '宽频带',
                model: 'STS-2.5',
                state: '在用',
                remark: '',
                calibrations: [
                  {
                    id: 'cal_ltx03_bb_1',
                    date: '2024-09-05',
                    sensitivity: 2251.3,
                    selfNoise: 2.05,
                    operator: '林之遥',
                    agency: '省地震局计量站',
                    remark: '脉冲响应合格',
                  },
                ],
              },
            },
          ],
        },
      ],
    },
    {
      id: 'arr_hx',
      name: '海西宽频带台阵',
      apertureKm: 46.2,
      deployDate: '2019-09-25',
      state: '运行中',
      department: '国家测震台网中心',
      stations: [
        {
          id: 'stn_hx_01',
          arrayId: 'arr_hx',
          code: 'HX01',
          lat: 25.4321,
          lng: 119.3421,
          elevM: 62,
          bedrock: '花岗岩',
          siteNote: '海岛台，防盐雾处理',
          installations: [
            {
              id: 'inst_hx01_bb',
              channel: '宽频带',
              installDate: '2019-09-25',
              remark: '海岛主用观测设备',
              current: {
                serialNo: 'TC-20190925-03',
                type: '宽频带',
                model: 'Trillium-Compact',
                state: '在用',
                remark: '',
                calibrations: [
                  {
                    id: 'cal_hx01_bb_1',
                    date: '2023-09-28',
                    sensitivity: 1498.2,
                    selfNoise: 2.25,
                    operator: '陈立群',
                    agency: '国家测震台网计量中心',
                    remark: '响应合格',
                  },
                  {
                    id: 'cal_hx01_bb_2',
                    date: '2024-09-30',
                    sensitivity: 1483.6,
                    selfNoise: 2.42,
                    operator: '陈立群',
                    agency: '国家测震台网计量中心',
                    remark: '变化 0.97%，合格',
                  },
                ],
              },
            },
            {
              id: 'inst_hx01_sm',
              channel: '强震',
              installDate: '2019-09-25',
              remark: '结构台阵强震观测',
              current: {
                serialNo: 'EST-20190925-04',
                type: '强震',
                model: 'ES-T',
                state: '在用',
                remark: '',
                calibrations: [
                  {
                    id: 'cal_hx01_sm_1',
                    date: '2024-09-30',
                    sensitivity: 1.24,
                    selfNoise: 1.05,
                    operator: '周渝',
                    agency: '国家测震台网计量中心',
                    remark: '强震通道合格',
                  },
                ],
              },
            },
          ],
        },
        {
          id: 'stn_hx_02',
          arrayId: 'arr_hx',
          code: 'HX02',
          lat: 25.2894,
          lng: 119.5112,
          elevM: 128,
          bedrock: '砂岩',
          siteNote: '覆盖层较厚，需做场地响应校正',
          installations: [
            {
              id: 'inst_hx02_bb',
              channel: '宽频带',
              installDate: '2019-09-26',
              remark: '夜间自噪抬升，待复标',
              current: {
                serialNo: 'CMG-3E-20190926-05',
                type: '宽频带',
                model: 'CMG-3ESPC',
                state: '待标定',
                remark: '',
                calibrations: [
                  {
                    id: 'cal_hx02_bb_1',
                    date: '2023-06-11',
                    sensitivity: 1388.4,
                    selfNoise: 3.9,
                    operator: '林之遥',
                    agency: '国家测震台网计量中心',
                    remark: '自噪接近上限，判定不合格',
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  ];

  // 更换记录：安装位换机留下的闭环
  const replaces: Replace[] = [
    {
      id: 'rpl_ltx02_st',
      installationId: 'inst_ltx02_st',
      reason: '雷击导致仪器损坏，标定不合格',
      oldSerialNo: 'L4C-20220315-08',
      newSerialNo: 'L4C-20250301-21',
      date: today,
      state: '待更换',
      operator: '周渝',
      remark: '新仪器已到货，待停电窗口安装',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'rpl_hx02_bb',
      installationId: 'inst_hx02_bb',
      reason: '自噪持续超标，按台网要求整机更换',
      oldSerialNo: 'CMG-3E-20190926-05',
      newSerialNo: 'CMG-3E-20250410-33',
      date: daysAgo(20),
      state: '已更换',
      operator: '林之遥',
      remark: '已完成安装，待复核标定',
      createdAt: now - 20 * 86400000,
      updatedAt: now - 18 * 86400000,
    },
  ];

  await db.transaction(
    'rw',
    [db.arrays, db.stations, db.instruments, db.installations, db.calibrations, db.replaces],
    async () => {
      const stamp = (offset: number): { createdAt: number; updatedAt: number } => ({
        createdAt: now + offset,
        updatedAt: now + offset,
      });

      const arrayRows: SeisArray[] = [];
      const stationRows: SeisStation[] = [];
      const instrumentRows: Instrument[] = [];
      const installationRows: Installation[] = [];
      const calibrationRows: Calibration[] = [];

      const pushDevice = (device: SeedDevice, offset: number): string => {
        const id = instrumentIdOf(device.serialNo);
        const lastDate = device.calibrations.map((c) => c.date).sort().pop() ?? null;
        instrumentRows.push({
          id,
          serialNo: device.serialNo,
          type: device.type,
          model: device.model,
          state: device.state,
          qualifyExpiryDate: qualifyExpiryDateOf(lastDate, null),
          remark: device.remark,
          ...stamp(offset),
        });
        device.calibrations.forEach((cal, calIndex) => {
          const verdict = judgeCalibration(device.type, cal.sensitivity, cal.selfNoise);
          calibrationRows.push({
            ...cal,
            instrumentId: id,
            responseVerdict: verdict,
            ...stamp(offset + calIndex + 1),
          });
        });
        return id;
      };

      arrays.forEach((seed, arrayIndex) => {
        const { stations, ...arrayRest } = seed;
        arrayRows.push({ ...arrayRest, stationCount: stations.length, ...stamp(arrayIndex) });
        stations.forEach((stationSeed, stationIndex) => {
          const { installations, ...stationRest } = stationSeed;
          stationRows.push({ ...stationRest, ...stamp(100 + arrayIndex * 100 + stationIndex) });
          installations.forEach((instSeed, instIndex) => {
            const offset = 200 + arrayIndex * 200 + stationIndex * 50 + instIndex * 10;
            // 当前在位数物理仪器
            pushDevice(instSeed.current, offset);
            // 已换下设备：历次标定跟原序列号走
            (instSeed.swappedOut ?? []).forEach((swap, swapIndex) => {
              pushDevice(swap.device, offset + 20 + swapIndex * 10);
              replaces.push({
                id: swap.replaceId,
                installationId: instSeed.id,
                reason: swap.reason,
                oldSerialNo: swap.device.serialNo,
                newSerialNo: instSeed.current.serialNo,
                date: swap.replacedAt,
                state: swap.replaceState,
                operator: '陈立群',
                remark: '换机完成，旧设备已停用',
                ...stamp(offset + 30 + swapIndex * 10),
              });
            });
            installationRows.push({
              id: instSeed.id,
              stationId: stationSeed.id,
              channel: instSeed.channel,
              serialNo: instSeed.current.serialNo,
              installDate: instSeed.installDate,
              syncStatus: '已认',
              remark: instSeed.remark,
              ...stamp(offset),
            });
          });
        });
      });

      await db.arrays.bulkPut(arrayRows);
      await db.stations.bulkPut(stationRows);
      await db.instruments.bulkPut(instrumentRows);
      await db.installations.bulkPut(installationRows);
      await db.calibrations.bulkPut(calibrationRows);
      await db.replaces.bulkPut(replaces);
    }
  );
}

/** 打开数据库并幂等播种：仅当台阵表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open();
  const count = await db.arrays.count();
  if (count === 0) {
    await seedDemoData();
  }
  stampDbVersion();
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.arrays, db.stations, db.instruments, db.installations, db.calibrations, db.replaces],
    async () => {
      await Promise.all([
        db.arrays.clear(),
        db.stations.clear(),
        db.instruments.clear(),
        db.installations.clear(),
        db.calibrations.clear(),
        db.replaces.clear(),
      ]);
    }
  );
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDemoData();
}

/** 统计各表行数，供页脚概览与几何页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [arrays, stations, instruments, installations, calibrations, replaces] = await Promise.all([
    db.arrays.count(),
    db.stations.count(),
    db.instruments.count(),
    db.installations.count(),
    db.calibrations.count(),
    db.replaces.count(),
  ]);
  return { arrays, stations, instruments, installations, calibrations, replaces };
}

/** 写入结构版本号到 localStorage，便于几何页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION));
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso);
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt);
  } catch {
    return null;
  }
}

export function readLastArrayId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastArrayId);
  } catch {
    return null;
  }
}

export function writeLastArrayId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastArrayId);
    else localStorage.setItem(LS_KEYS.lastArrayId, id);
  } catch {
    // 忽略
  }
}
