/**
 * 物理仪器 slice（计量站维护）：
 * 按序列号维护每台物理仪器的型号、档案状态；合格到期日由历次标定派生。
 * 序列号全局唯一；删除设备会连带其历次标定（标定跟着序列号走）。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import { runReconciliation } from '@/utils/sync';
import type { Device, DeviceState, InstrumentType } from '@/types/device';
import { qualifyDueOfSerial } from '@/utils/sync';
import type { RootState } from '@/stores/store';

type WithDevice = RootState;

export interface DeviceDraft {
  type: InstrumentType;
  model: string;
  serialNo: string;
  state: DeviceState;
  remark: string;
}

export function createEmptyDeviceDraft(): DeviceDraft {
  return { type: '宽频带', model: '', serialNo: '', state: '在用', remark: '' };
}

export interface DeviceSliceState {
  devices: Device[];
  ready: boolean;
  error: string | null;
  draft: DeviceDraft;
  lastReceipt: string;
}

const initialState: DeviceSliceState = {
  devices: [],
  ready: false,
  error: null,
  draft: createEmptyDeviceDraft(),
  lastReceipt: '',
};

export async function findSerialConflict(
  serialNo: string,
  excludeId?: string
): Promise<Device | undefined> {
  const rows = await db.devices.where('serialNo').equals(serialNo).toArray();
  return rows.find((row) => row.id !== excludeId);
}

export const createDevice = createAsyncThunk(
  'device/createDevice',
  async (payload: Omit<Device, 'id' | 'createdAt' | 'updatedAt' | 'qualifyDueDate'>, { rejectWithValue }) => {
    const serialNo = payload.serialNo.trim();
    const conflict = await findSerialConflict(serialNo);
    if (conflict) {
      return rejectWithValue(`序列号「${serialNo}」已被仪器 ${conflict.model} 建档`);
    }
    const now = Date.now();
    const row: Device = {
      ...payload,
      serialNo,
      qualifyDueDate: qualifyDueOfSerial(serialNo, await db.calibrations.toArray()),
      id: createId('dev'),
      createdAt: now,
      updatedAt: now,
    };
    await db.devices.put(row);
    // 建档后认领对应该序列号的挂账
    await runReconciliation();
    return { row };
  }
);

export const updateDevice = createAsyncThunk(
  'device/updateDevice',
  async (payload: { id: string; patch: Partial<Device> }, { rejectWithValue }) => {
    const patch = { ...payload.patch };
    if (typeof patch.serialNo === 'string') {
      patch.serialNo = patch.serialNo.trim();
      const conflict = await findSerialConflict(patch.serialNo, payload.id);
      if (conflict) return rejectWithValue(`序列号「${patch.serialNo}」已被占用`);
    }
    await db.devices.update(payload.id, { ...patch, updatedAt: Date.now() } as never);
    return payload;
  }
);

/** 删除物理仪器：历次标定跟着序列号一起从计量侧删除；安装位序列号进入挂账待核对 */
export const removeDevice = createAsyncThunk('device/removeDevice', async (deviceId: string) => {
  const device = await db.devices.get(deviceId);
  await db.transaction('rw', [db.devices, db.calibrations], async () => {
    if (device) await db.calibrations.where('serialNo').equals(device.serialNo).delete();
    await db.devices.delete(deviceId);
  });
  if (device) await runReconciliation();
  return deviceId;
});

/** 批量改档案状态 */
export const bulkSetDeviceState = createAsyncThunk(
  'device/bulkSetDeviceState',
  async (payload: { ids: string[]; state: DeviceState }) => {
    const now = Date.now();
    await db.devices
      .where('id')
      .anyOf(payload.ids)
      .modify((row) => {
        row.state = payload.state;
        row.updatedAt = now;
      });
    return payload;
  }
);

const deviceSlice = createSlice({
  name: 'device',
  initialState,
  reducers: {
    setDevices(state, action: PayloadAction<Device[]>) {
      state.devices = action.payload;
      state.ready = true;
      state.error = null;
    },
    setDeviceError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    patchDeviceDraft(state, action: PayloadAction<Partial<DeviceDraft>>) {
      state.draft = { ...state.draft, ...action.payload };
    },
    resetDeviceDraft(state) {
      state.draft = createEmptyDeviceDraft();
    },
    setDeviceReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createDevice.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '物理仪器建档失败';
      })
      .addCase(updateDevice.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '物理仪器更新失败';
      });
  },
});

export const {
  setDevices,
  setDeviceError,
  patchDeviceDraft,
  resetDeviceDraft,
  setDeviceReceipt,
} = deviceSlice.actions;

let started = false;

/** 启动物理仪器表实时订阅（幂等） */
export function startDeviceSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<Device>(() => db.devices).subscribe((rows) => {
    dispatch(setDevices(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectDeviceState = (state: WithDevice): DeviceSliceState => state.device;
export const selectDevices = (state: WithDevice): Device[] => state.device.devices;
export const selectDeviceReady = (state: WithDevice): boolean => state.device.ready;
export const selectDeviceDraft = (state: WithDevice): DeviceDraft => state.device.draft;
export const selectDeviceReceipt = (state: WithDevice): string => state.device.lastReceipt;

export const selectDeviceBySerial = (
  state: WithDevice,
  serialNo: string | null | undefined
): Device | null =>
  serialNo ? state.device.devices.find((row) => row.serialNo === serialNo) ?? null : null;

export default deviceSlice.reducer;
