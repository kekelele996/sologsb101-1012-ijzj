/**
 * IndexedDB 持久化层（Dexie 封装）
 * v3 起台账拆成两份：
 *  - installs：运维班组按台站记安装位、通道、安装日期、当前序列号（换机不改行）
 *  - devices ：计量站按序列号记物理仪器型号、历次标定（calibrations.serialNo）与合格到期日
 *  - claims/outbox：序列号对不上时挂账（写清台站，认过才算数）与两侧同步重试
 * 纯前端应用：不依赖任何后端服务或数据库服务。
 */
import Dexie, { liveQuery, type Table, type Transaction } from 'dexie';
import type { SeisArray } from '@/types/array';
import type { SeisStation } from '@/types/station';
import type { Install, InstallState } from '@/types/install';
import { LEGACY_CHANNEL } from '@/types/install';
import type { Device, DeviceState, InstrumentType } from '@/types/device';
import { plusCycle } from '@/types/device';
import { judgeCalibration } from '@/types/calibration';
import type { Calibration, ResponseVerdict } from '@/types/calibration';
import type { Replace } from '@/types/replace';
import type { SerialClaim } from '@/types/claim';
import type { SyncEvent } from '@/types/sync';
import { pumpOutbox, reconcileSerialClaims } from '@/utils/sync';

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
  installs: Install[];
  devices: Device[];
  calibrations: Calibration[];
  replaces: Replace[];
  claims: SerialClaim[];
  outbox: SyncEvent[];
}

/** 全部业务表（事务 / 清空 / 计数共用） */
export const ALL_TABLES = [
  'arrays',
  'stations',
  'installs',
  'devices',
  'calibrations',
  'replaces',
  'claims',
  'outbox',
] as const;

export class SeisArrayDatabase extends Dexie {
  arrays!: Table<SeisArray, string>;
  stations!: Table<SeisStation, string>;
  /** 运维班组：安装位台账 */
  installs!: Table<Install, string>;
  /** 计量站：物理仪器台账 */
  devices!: Table<Device, string>;
  calibrations!: Table<Calibration, string>;
  replaces!: Table<Replace, string>;
  /** 序列号挂账 */
  claims!: Table<SerialClaim, string>;
  /** 两侧同步事件 */
  outbox!: Table<SyncEvent, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（仪器与安装位同表）
    this.version(1).stores({
      arrays: 'id, name, state',
      stations: 'id, arrayId, code',
      instruments: 'id, stationId, serialNo, state',
      calibrations: 'id, instrumentId, date',
      replaces: 'id, instrumentId, state',
    });

    // v2：补齐筛选与统计索引
    this.version(2).stores({
      arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
      stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
      instruments: 'id, stationId, type, model, serialNo, installDate, state, updatedAt',
      calibrations: 'id, instrumentId, date, sensitivity, selfNoise, responseVerdict, updatedAt',
      replaces: 'id, instrumentId, state, date, newSerialNo, updatedAt',
    });

    // v3：仪器/安装位拆表，标定改挂序列号，新增挂账与同步事件表
    this.version(DB_VERSION)
      .stores({
        arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
        stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
        installs: 'id, stationId, serialNo, channel, installDate, state, updatedAt',
        devices: 'id, serialNo, type, model, qualifyDueDate, state, updatedAt',
        calibrations: 'id, serialNo, date, sensitivity, selfNoise, responseVerdict, updatedAt',
        replaces: 'id, installId, fromSerialNo, newSerialNo, state, date, updatedAt',
        claims: 'id, serialNo, state, source, stationId, installId, updatedAt',
        outbox: 'id, idempotencyKey, status, side, kind, serialNo, updatedAt',
        // instruments 表不再声明，Dexie 升级时自动删除（数据已拆分到 installs / devices）
      })
      .upgrade(async (tx) => {
        await migrateV2ToV3(tx);
      });
  }
}

/** 旧 v1/v2 仪器行（迁移期读取用） */
interface LegacyInstrument {
  id: string;
  stationId: string;
  type?: InstrumentType;
  model?: string;
  serialNo?: string;
  installDate?: string;
  state?: '在用' | '待标定' | '已停用';
  remark?: string;
  createdAt?: number;
  updatedAt?: number;
}

interface LegacyCalibration {
  id: string;
  instrumentId: string;
  date: string;
  sensitivity: number;
  selfNoise: number;
  responseVerdict?: ResponseVerdict;
  operator?: string;
  agency?: string;
  remark?: string;
  createdAt?: number;
  updatedAt?: number;
}

interface LegacyReplace {
  id: string;
  instrumentId: string;
  reason?: string;
  newSerialNo?: string;
  date?: string;
  state?: Replace['state'];
  operator?: string;
  remark?: string;
  createdAt?: number;
  updatedAt?: number;
}

const INSTALL_STATE_FROM_LEGACY: Record<NonNullable<LegacyInstrument['state']>, InstallState> = {
  在用: '在用',
  待标定: '待标定',
  已停用: '停用',
};

const DEVICE_STATE_FROM_LEGACY: Record<NonNullable<LegacyInstrument['state']>, DeviceState> = {
  在用: '在用',
  待标定: '库存',
  已停用: '停用',
};

/**
 * v2 → v3 迁移：
 * 旧 instruments 一行拆成 installs（安装位）+ devices（物理仪器）；
 * calibrations.instrumentId 改挂 serialNo；replaces 改挂 installId 并记下旧序列号；
 * 旧数据缺序列号归属的，先补一个「补登-」占位序列号，保证标定有归属，再留待计量站核实。
 */
async function migrateV2ToV3(tx: Transaction): Promise<void> {
  const legacyInstruments = (await tx
    .table('instruments')
    .toArray()) as LegacyInstrument[];
  const legacyCalibrations = (await tx.table('calibrations').toArray()) as LegacyCalibration[];
  const legacyReplaces = (await tx.table('replaces').toArray()) as LegacyReplace[];

  const now = Date.now();
  const installs: Install[] = [];
  const devices: Device[] = [];
  const deviceBySerial = new Map<string, Device>();

  /** 旧数据缺序列号时的补登序列号（先补上归属，事后由计量站核实） */
  const placeholderSerial = (row: LegacyInstrument): string =>
    `补登-${(row.model || '仪器').replace(/\s+/g, '').slice(0, 12)}-${row.id.slice(-6)}`.toUpperCase();

  legacyInstruments.forEach((row, index) => {
    const stamp = { createdAt: row.createdAt ?? now, updatedAt: row.updatedAt ?? now };
    const serial = (row.serialNo ?? '').trim() || placeholderSerial(row);
    const legacyState = row.state ?? '在用';
    const isPlaceholder = !row.serialNo || row.serialNo.trim() === '';

    // 安装位：沿用旧 id，通道在旧台账中没有，先记「未登记通道」
    installs.push({
      id: row.id,
      stationId: row.stationId,
      channel: LEGACY_CHANNEL,
      serialNo: serial,
      installDate: row.installDate ?? '',
      state: INSTALL_STATE_FROM_LEGACY[legacyState],
      remark: row.remark ?? '',
      ...stamp,
    });

    // 物理仪器：同序列号只建一档（旧数据正常情况下序列号全局唯一）
    if (!deviceBySerial.has(serial)) {
      const device: Device = {
        id: `dev_${row.id}`,
        type: row.type ?? '宽频带',
        model: row.model ?? '',
        serialNo: serial,
        qualifyDueDate: null,
        state: DEVICE_STATE_FROM_LEGACY[legacyState],
        remark: isPlaceholder
          ? `旧台账缺序列号，升级时按「${serial}」补登，请计量站核实后更正`
          : row.remark ?? '',
        createdAt: stamp.createdAt + index,
        updatedAt: stamp.updatedAt,
      };
      devices.push(device);
      deviceBySerial.set(serial, device);
    }
  });

  // 标定改挂序列号；设备合格到期日按最近一次合格标定回填
  const instrumentById = new Map(legacyInstruments.map((row) => [row.id, row]));
  const calibrations: Calibration[] = legacyCalibrations.map((row) => {
    const instrument = instrumentById.get(row.instrumentId);
    const serial =
      (instrument?.serialNo ?? '').trim() ||
      (instrument ? placeholderSerial(instrument) : `补登-未知-${row.id.slice(-6)}`.toUpperCase());
    const type = instrument?.type ?? '宽频带';
    const verdict =
      row.responseVerdict ?? judgeCalibration(type, row.sensitivity, row.selfNoise);
    return {
      id: row.id,
      serialNo: serial,
      date: row.date,
      sensitivity: row.sensitivity,
      selfNoise: row.selfNoise,
      responseVerdict: verdict,
      operator: row.operator ?? '',
      agency: row.agency ?? '',
      remark: row.remark ?? '',
      createdAt: row.createdAt ?? now,
      updatedAt: row.updatedAt ?? now,
    };
  });

  calibrations.forEach((calibration) => {
    const device = deviceBySerial.get(calibration.serialNo);
    if (device && calibration.responseVerdict === '合格') {
      const latest = latestQualifiedDate(calibrations, device.serialNo);
      if (latest) device.qualifyDueDate = plusCycle(latest);
    }
  });

  // 更换记录改挂安装位，并记下被换下的旧序列号
  const replaces: Replace[] = legacyReplaces.map((row) => {
    const instrument = instrumentById.get(row.instrumentId);
    const fromSerial =
      (instrument?.serialNo ?? '').trim() ||
      (instrument ? placeholderSerial(instrument) : '');
    return {
      id: row.id,
      installId: row.instrumentId,
      fromSerialNo: fromSerial,
      reason: row.reason ?? '',
      newSerialNo: row.newSerialNo ?? '',
      date: row.date ?? '',
      state: row.state ?? '待更换',
      operator: row.operator ?? '',
      remark: row.remark ?? '',
      createdAt: row.createdAt ?? now,
      updatedAt: row.updatedAt ?? now,
    };
  });

  await tx.table('installs').bulkPut(installs);
  await tx.table('devices').bulkPut(devices);
  await tx.table('calibrations').bulkPut(calibrations);
  await tx.table('replaces').bulkPut(replaces);
}

/** 取某序列号最近一次合格标定日期 */
function latestQualifiedDate(calibrations: Calibration[], serialNo: string): string | null {
  const qualified = calibrations
    .filter((row) => row.serialNo === serialNo && row.responseVerdict === '合格')
    .sort((a, b) => b.date.localeCompare(a.date));
  return qualified[0]?.date ?? null;
}

export const db = new SeisArrayDatabase();

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
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
  state: DeviceState;
  remark: string;
  calibrations: SeedCalibration[];
}

interface SeedInstall {
  id: string;
  stationId: string;
  channel: string;
  serialNo: string;
  installDate: string;
  state: InstallState;
  remark: string;
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
  installs: SeedInstall[];
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
 * 播种演示数据：2 个台阵 → 5 个台站 → 9 个安装位 / 11 台物理仪器（含换机前后各一台）
 * → 12 条标定 → 3 条更换 → 1 条待认领挂账。
 * 刻意覆盖：换机后旧仪器标定仍挂旧序列号、不合格标定、超期未标定、待认领序列号。
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
          installs: [
            {
              id: 'ins_ltx01_bb',
              stationId: 'stn_ltx_01',
              channel: 'BHZ',
              serialNo: 'CMG-3E-20210418-01',
              installDate: '2021-04-18',
              state: '在用',
              remark: '主用宽频带，配 24 位采集器',
            },
            {
              // 已复核换机：安装位保留，序列号已落到新机；旧机标定仍挂旧序列号
              id: 'ins_ltx01_st',
              stationId: 'stn_ltx_01',
              channel: 'SPZ',
              serialNo: 'FSS3B-20250506-24',
              installDate: daysAgo(60),
              state: '在用',
              remark: '备份短周期通道，新机复核标定合格',
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
          installs: [
            {
              id: 'ins_ltx02_bb',
              stationId: 'stn_ltx_02',
              channel: 'BHZ',
              serialNo: 'T120-20220315-07',
              installDate: '2022-03-15',
              state: '待标定',
              remark: '井下安装，深度 42 m，标定已超期',
            },
            {
              id: 'ins_ltx02_st',
              stationId: 'stn_ltx_02',
              channel: 'SPZ',
              serialNo: 'L4C-20220315-08',
              installDate: '2022-03-15',
              state: '停用',
              remark: '2024 年雷击损坏，已提交更换，待停电窗口施工',
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
          installs: [
            {
              id: 'ins_ltx03_bb',
              stationId: 'stn_ltx_03',
              channel: 'BHZ',
              serialNo: 'STS25-20230902-11',
              installDate: '2023-09-02',
              state: '在用',
              remark: '新建站首台仪器',
            },
            {
              // 运维先装了、计量站尚无档案 → 序列号挂账待认领
              id: 'ins_ltx03_sm',
              stationId: 'stn_ltx_03',
              channel: 'SLZ',
              serialNo: 'EST-20260820-41',
              installDate: daysAgo(12),
              state: '在用',
              remark: '新加装强震通道，设备资料已催计量站补建档',
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
          installs: [
            {
              id: 'ins_hx01_bb',
              stationId: 'stn_hx_01',
              channel: 'BHZ',
              serialNo: 'TC-20190925-03',
              installDate: '2019-09-25',
              state: '在用',
              remark: '海岛主用观测设备',
            },
            {
              id: 'ins_hx01_sm',
              stationId: 'stn_hx_01',
              channel: 'SLZ',
              serialNo: 'EST-20190925-04',
              installDate: '2019-09-25',
              state: '在用',
              remark: '结构台阵强震观测',
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
          installs: [
            {
              // 已更换待复核：新机已落位，尚未做安装后标定
              id: 'ins_hx02_bb',
              stationId: 'stn_hx_02',
              channel: 'BHZ',
              serialNo: 'CMG-3E-20250410-33',
              installDate: daysAgo(20),
              state: '待标定',
              remark: '新机已安装，待安装后首次标定',
            },
          ],
        },
      ],
    },
  ];

  /** 物理仪器档案：换机前后各一台，旧机停用但标定完整保留 */
  const devices: SeedDevice[] = [
    {
      serialNo: 'CMG-3E-20210418-01',
      type: '宽频带',
      model: 'CMG-3ESPC',
      state: '在用',
      remark: '主用宽频带',
      calibrations: [
        { date: daysAgo(510), sensitivity: 1502.4, selfNoise: 1.82, operator: '陈立群', agency: '省地震局计量站', remark: '响应曲线平滑' },
        { date: daysAgo(145), sensitivity: 1468.9, selfNoise: 1.95, operator: '陈立群', agency: '省地震局计量站', remark: '灵敏度略降 2.2%，仍在限内' },
      ],
    },
    {
      // LTX01 SPZ 旧机：已换下停用，历次标定保留
      serialNo: 'FSS3B-20210418-02',
      type: '短周期',
      model: 'FSS-3B',
      state: '停用',
      remark: '超期后换下，返厂检修',
      calibrations: [
        { date: daysAgo(820), sensitivity: 412.6, selfNoise: 2.4, operator: '周渝', agency: '省地震局计量站', remark: '首次标定' },
      ],
    },
    {
      // LTX01 SPZ 新机
      serialNo: 'FSS3B-20250506-24',
      type: '短周期',
      model: 'FSS-3B',
      state: '在用',
      remark: '更换新机，复核标定合格',
      calibrations: [
        { date: daysAgo(30), sensitivity: 436.2, selfNoise: 2.1, operator: '陈立群', agency: '省地震局计量站', remark: '安装后复核标定合格' },
      ],
    },
    {
      serialNo: 'T120-20220315-07',
      type: '宽频带',
      model: 'Trillium-120',
      state: '在用',
      remark: '标定已超期',
      calibrations: [
        { date: daysAgo(402), sensitivity: 1204.8, selfNoise: 1.42, operator: '林之遥', agency: '省地震局计量站', remark: '响应一致性良好' },
      ],
    },
    {
      serialNo: 'L4C-20220315-08',
      type: '短周期',
      model: 'L-4C-3D',
      state: '停用',
      remark: '雷击损坏，标定不合格',
      calibrations: [
        { date: daysAgo(600), sensitivity: 265.2, selfNoise: 4.8, operator: '周渝', agency: '省地震局计量站', remark: '自噪超标，判定不合格' },
      ],
    },
    {
      // 新机已到货入库建档，尚未安装
      serialNo: 'L4C-20250301-21',
      type: '短周期',
      model: 'L-4C-3D',
      state: '库存',
      remark: '备品，待停电窗口安装到 LTX02 SPZ',
      calibrations: [],
    },
    {
      serialNo: 'STS25-20230902-11',
      type: '宽频带',
      model: 'STS-2.5',
      state: '在用',
      remark: '',
      calibrations: [
        { date: daysAgo(88), sensitivity: 2251.3, selfNoise: 2.05, operator: '林之遥', agency: '省地震局计量站', remark: '脉冲响应合格' },
      ],
    },
    {
      serialNo: 'TC-20190925-03',
      type: '宽频带',
      model: 'Trillium-Compact',
      state: '在用',
      remark: '',
      calibrations: [
        { date: daysAgo(425), sensitivity: 1498.2, selfNoise: 2.25, operator: '陈立群', agency: '国家测震台网计量中心', remark: '响应合格' },
        { date: daysAgo(62), sensitivity: 1483.6, selfNoise: 2.42, operator: '陈立群', agency: '国家测震台网计量中心', remark: '变化 0.97%，合格' },
      ],
    },
    {
      serialNo: 'EST-20190925-04',
      type: '强震',
      model: 'ES-T',
      state: '在用',
      remark: '',
      calibrations: [
        { date: daysAgo(210), sensitivity: 1.24, selfNoise: 1.05, operator: '周渝', agency: '国家测震台网计量中心', remark: '强震通道合格' },
      ],
    },
    {
      // HX02 BHZ 旧机：不合格后换下
      serialNo: 'CMG-3E-20190926-05',
      type: '宽频带',
      model: 'CMG-3ESPC',
      state: '停用',
      remark: '夜间自噪抬升，整机换下',
      calibrations: [
        { date: daysAgo(480), sensitivity: 1388.4, selfNoise: 3.9, operator: '林之遥', agency: '国家测震台网计量中心', remark: '自噪接近上限，判定不合格' },
      ],
    },
    {
      // HX02 BHZ 新机：已装机，待首次标定
      serialNo: 'CMG-3E-20250410-33',
      type: '宽频带',
      model: 'CMG-3ESPC',
      state: '在用',
      remark: '换机新机，待安装后标定',
      calibrations: [],
    },
    // 注意：EST-20260820-41 刻意不在此建档，留给序列号挂账演示
  ];

  const replaces: Replace[] = [
    {
      id: 'rpl_ltx02_st',
      installId: 'ins_ltx02_st',
      fromSerialNo: 'L4C-20220315-08',
      reason: '雷击导致仪器损坏，标定不合格',
      newSerialNo: 'L4C-20250301-21',
      date: today,
      state: '待更换',
      operator: '周渝',
      remark: '新仪器已到货入库，待停电窗口安装',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'rpl_hx02_bb',
      installId: 'ins_hx02_bb',
      fromSerialNo: 'CMG-3E-20190926-05',
      reason: '自噪持续超标，按台网要求整机更换',
      newSerialNo: 'CMG-3E-20250410-33',
      date: daysAgo(20),
      state: '已更换',
      operator: '林之遥',
      remark: '已完成安装，待复核标定',
      createdAt: now - 20 * 86400000,
      updatedAt: now - 18 * 86400000,
    },
    {
      id: 'rpl_ltx01_st',
      installId: 'ins_ltx01_st',
      fromSerialNo: 'FSS3B-20210418-02',
      reason: '超期未标定，更换为新型号',
      newSerialNo: 'FSS3B-20250506-24',
      date: daysAgo(60),
      state: '已复核',
      operator: '陈立群',
      remark: '复核标定合格，序列号已落到安装位',
      createdAt: now - 60 * 86400000,
      updatedAt: now - 30 * 86400000,
    },
  ];

  await db.transaction(
    'rw',
    [db.arrays, db.stations, db.installs, db.devices, db.calibrations, db.replaces, db.claims, db.outbox],
    async () => {
      const stamp = (offset: number): { createdAt: number; updatedAt: number } => ({
        createdAt: now + offset,
        updatedAt: now + offset,
      });

      const arrayRows: SeisArray[] = [];
      const stationRows: SeisStation[] = [];
      const installRows: Install[] = [];
      const deviceRows: Device[] = [];
      const calibrationRows: Calibration[] = [];

      arrays.forEach((seed, arrayIndex) => {
        const { stations: stns, ...arrayRest } = seed;
        arrayRows.push({ ...arrayRest, stationCount: stns.length, ...stamp(arrayIndex) });
        stns.forEach((stationSeed, stationIndex) => {
          const { installs: insRows, ...stationRest } = stationSeed;
          stationRows.push({ ...stationRest, ...stamp(100 + arrayIndex * 100 + stationIndex) });
          insRows.forEach((installSeed, installIndex) => {
            installRows.push({
              ...installSeed,
              ...stamp(200 + arrayIndex * 200 + stationIndex * 50 + installIndex),
            });
          });
        });
      });

      devices.forEach((deviceSeed, deviceIndex) => {
        const deviceStamp = stamp(300 + deviceIndex);
        const calRows: Calibration[] = deviceSeed.calibrations.map((calSeed, calIndex) => {
          const verdict = judgeCalibration(
            deviceSeed.type,
            calSeed.sensitivity,
            calSeed.selfNoise
          );
          return {
            id: `cal_${deviceSeed.serialNo.replace(/[^a-zA-Z0-9]/g, '_')}_${calIndex + 1}`,
            serialNo: deviceSeed.serialNo,
            ...calSeed,
            responseVerdict: verdict,
            ...stamp(400 + deviceIndex * 20 + calIndex),
          };
        });
        const latestQualified = calRows
          .filter((row) => row.responseVerdict === '合格')
          .sort((a, b) => b.date.localeCompare(a.date))[0];
        deviceRows.push({
          id: `dev_${deviceSeed.serialNo.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`,
          type: deviceSeed.type,
          model: deviceSeed.model,
          serialNo: deviceSeed.serialNo,
          qualifyDueDate: latestQualified ? plusCycle(latestQualified.date) : null,
          state: deviceSeed.state,
          remark: deviceSeed.remark,
          ...deviceStamp,
        });
        calibrationRows.push(...calRows);
      });

      await db.arrays.bulkPut(arrayRows);
      await db.stations.bulkPut(stationRows);
      await db.installs.bulkPut(installRows);
      await db.devices.bulkPut(deviceRows);
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
  // 启动即对账一次并推送同步事件（幂等）
  await reconcileSerialClaims();
  await pumpOutbox();
  stampDbVersion();
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction('rw', ALL_TABLES.map((name) => db.table(name)), async () => {
    await Promise.all(ALL_TABLES.map((name) => db.table(name).clear()));
  });
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDemoData();
  await reconcileSerialClaims();
  await pumpOutbox();
}

/** 统计各表行数，供页脚概览与几何页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [arrays, stations, installs, devices, calibrations, replaces, claims, outbox] = await Promise.all([
    db.arrays.count(),
    db.stations.count(),
    db.installs.count(),
    db.devices.count(),
    db.calibrations.count(),
    db.replaces.count(),
    db.claims.count(),
    db.outbox.count(),
  ]);
  return { arrays, stations, installs, devices, calibrations, replaces, claims, outbox };
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
