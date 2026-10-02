/**
 * 标定 slice（计量站为主）：
 * 标定记录按物理仪器序列号挂，录入后重算该序列号的合格到期日；
 * 更换记录按安装位挂，换机=安装位序列号落到新设备，旧序列号标定不动。
 * 同时维护序列号挂账（claims）与两侧同步事件（outbox）。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import type {
  Calibration,
  CalibrationFilterState,
  ResponseVerdict,
} from '@/types/calibration';
import { createEmptyCalibrationFilter, judgeCalibration, sensitivityDelta } from '@/types/calibration';
import type { Replace, ReplaceFilterState, ReplaceState } from '@/types/replace';
import { canTransition, createEmptyReplaceFilter } from '@/types/replace';
import type { Device } from '@/types/device';
import type { SerialClaim, ClaimFilterState, ClaimState } from '@/types/claim';
import { createEmptyClaimFilter } from '@/types/claim';
import type { SyncEvent, SyncSide } from '@/types/sync';
import {
  reconcileSerialClaims,
  recomputeDeviceQualify,
  retrySide,
  runReconciliation,
} from '@/utils/sync';
import type { RootState } from '@/stores/store';

type WithCalibration = RootState;

export interface CalibrationSliceState {
  calibrations: Calibration[];
  replaces: Replace[];
  claims: SerialClaim[];
  outbox: SyncEvent[];
  /** 设备表只读副本（标定页显示型号/类型） */
  devices: Device[];
  ready: boolean;
  error: string | null;
  filter: CalibrationFilterState;
  replaceFilter: ReplaceFilterState;
  claimFilter: ClaimFilterState;
  lastReceipt: string;
}

const initialState: CalibrationSliceState = {
  calibrations: [],
  replaces: [],
  claims: [],
  outbox: [],
  devices: [],
  ready: false,
  error: null,
  filter: createEmptyCalibrationFilter(),
  replaceFilter: createEmptyReplaceFilter(),
  claimFilter: createEmptyClaimFilter(),
  lastReceipt: '',
};

/* ------------------------------ 标定 ------------------------------ */

export const createCalibration = createAsyncThunk(
  'calibration/createCalibration',
  async (payload: Omit<Calibration, 'id' | 'createdAt' | 'updatedAt' | 'responseVerdict'>) => {
    const now = Date.now();
    const serialNo = payload.serialNo.trim();
    const device = await db.devices.where('serialNo').equals(serialNo).first();
    const verdict = judgeCalibration(device?.type ?? '宽频带', payload.sensitivity, payload.selfNoise);
    const row: Calibration = {
      ...payload,
      serialNo,
      responseVerdict: verdict,
      id: createId('cal'),
      createdAt: now,
      updatedAt: now,
    };
    await db.calibrations.put(row);
    if (device) await recomputeDeviceQualify(serialNo);
    // 标定序列号对不上时挂账
    await reconcileSerialClaims();
    return row;
  }
);

export const updateCalibration = createAsyncThunk(
  'calibration/updateCalibration',
  async (payload: { id: string; patch: Partial<Calibration> }) => {
    const existing = await db.calibrations.get(payload.id);
    const serialNo = (payload.patch.serialNo ?? existing?.serialNo ?? '').trim();
    const device = await db.devices.where('serialNo').equals(serialNo).first();
    const nextSensitivity = payload.patch.sensitivity ?? existing?.sensitivity ?? 0;
    const nextNoise = payload.patch.selfNoise ?? existing?.selfNoise ?? 0;
    const verdict = judgeCalibration(device?.type ?? '宽频带', nextSensitivity, nextNoise);
    await db.calibrations.update(payload.id, {
      ...payload.patch,
      serialNo,
      responseVerdict: payload.patch.responseVerdict ?? verdict,
      updatedAt: Date.now(),
    } as never);
    await recomputeDeviceQualify(serialNo);
    if (existing && existing.serialNo !== serialNo) {
      await recomputeDeviceQualify(existing.serialNo);
    }
    await reconcileSerialClaims();
    return payload;
  }
);

export const removeCalibration = createAsyncThunk(
  'calibration/removeCalibration',
  async (calibrationId: string) => {
    const existing = await db.calibrations.get(calibrationId);
    await db.calibrations.delete(calibrationId);
    if (existing) await recomputeDeviceQualify(existing.serialNo);
    return calibrationId;
  }
);

/** 批量改响应结论 */
export const bulkSetVerdict = createAsyncThunk(
  'calibration/bulkSetVerdict',
  async (payload: { ids: string[]; verdict: ResponseVerdict }) => {
    const now = Date.now();
    const touchedSerials = new Set<string>();
    await db.calibrations
      .where('id')
      .anyOf(payload.ids)
      .modify((row) => {
        row.responseVerdict = payload.verdict;
        row.updatedAt = now;
        touchedSerials.add(row.serialNo);
      });
    await Promise.all(Array.from(touchedSerials).map((serial) => recomputeDeviceQualify(serial)));
    return payload;
  }
);

/* ------------------------------ 更换（按安装位） ------------------------------ */

export const createReplace = createAsyncThunk(
  'calibration/createReplace',
  async (payload: Omit<Replace, 'id' | 'createdAt' | 'updatedAt' | 'fromSerialNo'>) => {
    const now = Date.now();
    const install = await db.installs.get(payload.installId);
    const row: Replace = {
      ...payload,
      installId: payload.installId,
      newSerialNo: payload.newSerialNo.trim(),
      fromSerialNo: install?.serialNo ?? '',
      id: createId('rpl'),
      createdAt: now,
      updatedAt: now,
    };
    await db.replaces.put(row);
    return row;
  }
);

export const updateReplace = createAsyncThunk(
  'calibration/updateReplace',
  async (payload: { id: string; patch: Partial<Replace> }) => {
    await db.replaces.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
    return payload;
  }
);

export const removeReplace = createAsyncThunk('calibration/removeReplace', async (id: string) => {
  await db.replaces.delete(id);
  return id;
});

/**
 * 推进更换状态机：
 *  - 到「已更换」：安装位保留、序列号落到新设备、安装日期改为换机日；
 *    旧设备在计量侧置停用，新设备置在用；新序列号无档案则先挂账；
 *  - 回退到「待更换」：不回滚已认过的序列号归属（换机事实保留）。
 */
export const transitionReplace = createAsyncThunk(
  'calibration/transitionReplace',
  async (payload: { id: string; next: ReplaceState }, { rejectWithValue }) => {
    const replace = await db.replaces.get(payload.id);
    if (!replace) return rejectWithValue('更换记录不存在');
    if (!canTransition(replace.state, payload.next)) {
      return rejectWithValue(`状态机不允许从「${replace.state}」流转到「${payload.next}」`);
    }
    const now = Date.now();
    await db.transaction(
      'rw',
      [db.replaces, db.installs, db.devices],
      async () => {
        await db.replaces.update(payload.id, { state: payload.next, updatedAt: now } as never);
        if (payload.next === '已更换') {
          // 安装位保留，序列号落到新的一台
          await db.installs.update(replace.installId, {
            serialNo: replace.newSerialNo,
            installDate: replace.date,
            state: '待标定',
            updatedAt: now,
          } as never);
          // 旧设备停用（标定不动），新设备在用
          if (replace.fromSerialNo) {
            const oldDevice = await db.devices.where('serialNo').equals(replace.fromSerialNo).first();
            if (oldDevice) {
              await db.devices.update(oldDevice.id, { state: '停用', updatedAt: now } as never);
            }
          }
          const newDevice = await db.devices.where('serialNo').equals(replace.newSerialNo).first();
          if (newDevice) {
            await db.devices.update(newDevice.id, { state: '在用', updatedAt: now } as never);
          }
        }
        if (payload.next === '已复核') {
          await db.installs.update(replace.installId, { state: '在用', updatedAt: now } as never);
          const newDevice = await db.devices.where('serialNo').equals(replace.newSerialNo).first();
          if (newDevice) await db.devices.update(newDevice.id, { state: '在用', updatedAt: now } as never);
        }
      }
    );
    // 新序列号计量站无档案 → 挂账
    await runReconciliation();
    return payload;
  }
);

/* ------------------------------ 挂账与同步重试 ------------------------------ */

export const retrySideEvents = createAsyncThunk(
  'calibration/retrySideEvents',
  async (side: SyncSide) => {
    const count = await retrySide(side);
    return { side, count };
  }
);

export const runClaimsReconciliation = createAsyncThunk(
  'calibration/runClaimsReconciliation',
  async () => runReconciliation()
);

const calibrationSlice = createSlice({
  name: 'calibration',
  initialState,
  reducers: {
    setCalibrations(state, action: PayloadAction<Calibration[]>) {
      state.calibrations = action.payload;
      state.ready = true;
      state.error = null;
    },
    setReplaces(state, action: PayloadAction<Replace[]>) {
      state.replaces = action.payload;
    },
    setClaims(state, action: PayloadAction<SerialClaim[]>) {
      state.claims = action.payload;
    },
    setOutbox(state, action: PayloadAction<SyncEvent[]>) {
      state.outbox = action.payload;
    },
    setDevicesForCalibration(state, action: PayloadAction<Device[]>) {
      state.devices = action.payload;
    },
    patchFilter(state, action: PayloadAction<Partial<CalibrationFilterState>>) {
      state.filter = { ...state.filter, ...action.payload };
    },
    resetFilter(state) {
      state.filter = createEmptyCalibrationFilter();
    },
    patchReplaceFilter(state, action: PayloadAction<Partial<ReplaceFilterState>>) {
      state.replaceFilter = { ...state.replaceFilter, ...action.payload };
    },
    resetReplaceFilter(state) {
      state.replaceFilter = createEmptyReplaceFilter();
    },
    patchClaimFilter(state, action: PayloadAction<Partial<ClaimFilterState>>) {
      state.claimFilter = { ...state.claimFilter, ...action.payload };
    },
    resetClaimFilter(state) {
      state.claimFilter = createEmptyClaimFilter();
    },
    setCalibrationError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setCalibrationReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createCalibration.fulfilled, (state, action) => {
        state.lastReceipt = `标定记录已保存，响应结论自动初判为「${action.payload.responseVerdict}」，合格到期日已重算`;
      })
      .addCase(bulkSetVerdict.fulfilled, (state, action) => {
        state.lastReceipt = `已批量将 ${action.payload.ids.length} 条标定记录的响应结论改为「${action.payload.verdict}」`;
      })
      .addCase(transitionReplace.fulfilled, (state, action) => {
        state.lastReceipt =
          action.payload.next === '已更换'
            ? '换机完成：安装位保留，序列号已落到新设备，旧设备历次标定仍挂旧序列号'
            : `更换记录状态已流转到「${action.payload.next}」`;
      })
      .addCase(transitionReplace.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '更换状态流转失败';
      });
  },
});

export const {
  setCalibrations,
  setReplaces,
  setClaims,
  setOutbox,
  setDevicesForCalibration,
  patchFilter,
  resetFilter,
  patchReplaceFilter,
  resetReplaceFilter,
  patchClaimFilter,
  resetClaimFilter,
  setCalibrationError,
  setCalibrationReceipt,
} = calibrationSlice.actions;

let started = false;

/** 启动标定 / 更换 / 挂账 / 同步 / 设备表实时订阅（幂等） */
export function startCalibrationSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<Calibration>(() => db.calibrations).subscribe((rows) => dispatch(setCalibrations(rows)));
  watchTable<Replace>(() => db.replaces).subscribe((rows) => dispatch(setReplaces(rows)));
  watchTable<SerialClaim>(() => db.claims).subscribe((rows) => dispatch(setClaims(rows)));
  watchTable<SyncEvent>(() => db.outbox).subscribe((rows) => dispatch(setOutbox(rows)));
  watchTable<Device>(() => db.devices).subscribe((rows) => dispatch(setDevicesForCalibration(rows)));
}

/* ------------------------------ Selector ------------------------------ */

export const selectCalibrationState = (state: WithCalibration): CalibrationSliceState =>
  state.calibration;
export const selectCalibrations = (state: WithCalibration): Calibration[] =>
  state.calibration.calibrations;
export const selectReplaces = (state: WithCalibration): Replace[] => state.calibration.replaces;
export const selectClaims = (state: WithCalibration): SerialClaim[] => state.calibration.claims;
export const selectOutbox = (state: WithCalibration): SyncEvent[] => state.calibration.outbox;
export const selectCalibrationDevices = (state: WithCalibration): Device[] =>
  state.calibration.devices;
export const selectCalibrationReady = (state: WithCalibration): boolean => state.calibration.ready;
export const selectCalibrationFilter = (state: WithCalibration): CalibrationFilterState =>
  state.calibration.filter;
export const selectReplaceFilter = (state: WithCalibration): ReplaceFilterState =>
  state.calibration.replaceFilter;
export const selectClaimFilter = (state: WithCalibration) => state.calibration.claimFilter;
export const selectCalibrationReceipt = (state: WithCalibration): string =>
  state.calibration.lastReceipt;

export const selectPendingClaimCount = (state: WithCalibration): number =>
  state.calibration.claims.filter((claim) => claim.state === '待认领').length;
export const selectFailedEventCount = (state: WithCalibration): number =>
  state.calibration.outbox.filter((event) => event.status === 'failed').length;

export const selectCalibrationsOfSerial = (
  state: WithCalibration,
  serialNo: string | null | undefined
): Calibration[] => {
  if (!serialNo) return [];
  return state.calibration.calibrations
    .filter((row) => row.serialNo === serialNo)
    .sort((a, b) => b.date.localeCompare(a.date));
};

export const selectReplacesOfInstall = (
  state: WithCalibration,
  installId: string | null | undefined
): Replace[] => {
  if (!installId) return [];
  return state.calibration.replaces.filter((row) => row.installId === installId);
};

/** 标定 id → 灵敏度变化（相对同一序列号上一次标定） */
export const selectSensitivityDeltas = (
  state: WithCalibration
): Record<string, ReturnType<typeof sensitivityDelta>> => {
  const result: Record<string, ReturnType<typeof sensitivityDelta>> = {};
  const grouped = new Map<string, Calibration[]>();
  state.calibration.calibrations.forEach((row) => {
    const list = grouped.get(row.serialNo) ?? [];
    list.push(row);
    grouped.set(row.serialNo, list);
  });
  grouped.forEach((list) => {
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    sorted.forEach((row, index) => {
      const previous = index > 0 ? sorted[index - 1].sensitivity : null;
      result[row.id] = sensitivityDelta(row.sensitivity, previous);
    });
  });
  return result;
};

/** 挂账按状态分组计数 */
export const selectClaimCounts = (state: WithCalibration): Record<ClaimState, number> => {
  const counts: Record<ClaimState, number> = { 待认领: 0, 已认领: 0, 已驳回: 0 };
  state.calibration.claims.forEach((claim) => {
    counts[claim.state] += 1;
  });
  return counts;
};

export default calibrationSlice.reducer;
