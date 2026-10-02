/**
 * 仪器 slice：维护物理仪器（计量站台账）与安装位（运维班组台账）两份数据。
 * - 物理仪器按序列号记账：型号、历次标定、合格到期日
 * - 安装位按台站记账：通道、安装日期、当前序列号、认账状态
 * 换机后安装位留着、序列号落到新的一台，历次标定跟着原序列号走。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, instrumentIdOf, watchTable } from '@/utils/db';
import type {
  Installation,
  Instrument,
  InstrumentDraft,
  InstrumentState,
  InstrumentType,
  SyncStatus,
} from '@/types/instrument';
import { createEmptyInstrumentDraft, qualifyExpiryDateOf } from '@/types/instrument';
import type { RootState } from '@/stores/store';

/** 选择器入参统一用 RootState */
type WithInstrument = RootState;

export interface InstrumentSliceState {
  instruments: Instrument[];
  installations: Installation[];
  ready: boolean;
  error: string | null;
  /** 当前选中的台站（台站仪器页上下文） */
  currentStationId: string | null;
  /** 仪器登记草稿（跨页面保留） */
  draft: InstrumentDraft;
  /** 最近一次保存回执（用于页面提示） */
  lastReceipt: string;
}

const initialState: InstrumentSliceState = {
  instruments: [],
  installations: [],
  ready: false,
  error: null,
  currentStationId: null,
  draft: createEmptyInstrumentDraft(),
  lastReceipt: '',
};

/** 序列号唯一性校验：返回冲突的物理仪器（排除自身） */
export async function findSerialConflict(
  serialNo: string,
  excludeId?: string
): Promise<Instrument | undefined> {
  const rows = await db.instruments.where('serialNo').equals(serialNo).toArray();
  return rows.find((row) => row.id !== excludeId);
}

/** 某序列号是否已在某个安装位在位数（设备不能同时装两处） */
async function findInstalledElsewhere(serialNo: string, excludeInstallationId?: string): Promise<boolean> {
  const rows = await db.installations.where('serialNo').equals(serialNo).toArray();
  return rows.some((row) => row.id !== excludeInstallationId);
}

export interface CreateInstrumentPayload {
  stationId: string;
  channel: string;
  type: InstrumentType;
  model: string;
  serialNo: string;
  installDate: string;
  state: InstrumentState;
  remark: string;
}

/**
 * 登记仪器：同时建物理仪器（计量站台账）与安装位（运维班组台账）。
 * 序列号全局唯一；登记后安装位与物理仪器一致（已认）。
 */
export const createInstrument = createAsyncThunk(
  'instrument/createInstrument',
  async (payload: CreateInstrumentPayload, { rejectWithValue }) => {
    const serialNo = payload.serialNo.trim();
    const conflict = await findSerialConflict(serialNo);
    if (conflict) {
      return rejectWithValue(`序列号「${serialNo}」已被仪器 ${conflict.model} 占用`);
    }
    const installed = await findInstalledElsewhere(serialNo);
    if (installed) {
      return rejectWithValue(`序列号「${serialNo}」已在其他安装位在位数，不能重复安装`);
    }
    const now = Date.now();
    const instrumentId = instrumentIdOf(serialNo);
    const instrument: Instrument = {
      id: instrumentId,
      serialNo,
      type: payload.type,
      model: payload.model.trim(),
      state: payload.state,
      qualifyExpiryDate: qualifyExpiryDateOf(null, payload.installDate),
      remark: payload.remark.trim(),
      createdAt: now,
      updatedAt: now,
    };
    const installation: Installation = {
      id: createId('inst'),
      stationId: payload.stationId,
      channel: payload.channel.trim() || payload.type,
      serialNo,
      installDate: payload.installDate,
      syncStatus: '已认',
      remark: '',
      createdAt: now,
      updatedAt: now,
    };
    await db.transaction('rw', [db.instruments, db.installations], async () => {
      await db.instruments.put(instrument);
      await db.installations.put(installation);
    });
    return { instrument, installation };
  }
);

/** 更新物理仪器（计量站台账字段） */
export const updateInstrument = createAsyncThunk(
  'instrument/updateInstrument',
  async (payload: { id: string; patch: Partial<Instrument> }, { rejectWithValue }) => {
    if (payload.patch.serialNo) {
      const conflict = await findSerialConflict(payload.patch.serialNo, payload.id);
      if (conflict) {
        return rejectWithValue(`序列号「${payload.patch.serialNo}」已被占用`);
      }
    }
    await db.instruments.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
    return payload;
  }
);

/**
 * 换机：安装位留着，把序列号落到新的一台。
 * - 原序列号对应的物理仪器标记为已停用（历次标定跟原序列号走）
 * - 新序列号在计量站台账存在 → 安装位已认；不存在 → 待认（先挂台账，认过才算数）
 * - 同步生成一条更换记录
 */
export interface SwapPayload {
  installationId: string;
  newSerialNo: string;
  reason: string;
  date: string;
  operator: string;
}

export const swapInstrument = createAsyncThunk(
  'instrument/swapInstrument',
  async (payload: SwapPayload, { rejectWithValue }) => {
    const now = Date.now();
    const installation = await db.installations.get(payload.installationId);
    if (!installation) return rejectWithValue('安装位不存在');
    const newSerialNo = payload.newSerialNo.trim();
    if (newSerialNo === installation.serialNo) {
      return rejectWithValue('新序列号与当前序列号相同，无需换机');
    }
    const installed = await findInstalledElsewhere(newSerialNo, installation.id);
    if (installed) {
      return rejectWithValue(`序列号「${newSerialNo}」已在其他安装位在位数`);
    }
    const oldSerialNo = installation.serialNo;
    const newDevice = await db.instruments.where('serialNo').equals(newSerialNo).first();
    const syncStatus: SyncStatus = newDevice ? '已认' : '待认';

    await db.transaction('rw', [db.installations, db.instruments, db.replaces], async () => {
      // 安装位留着，只改写到新序列号
      await db.installations.update(installation.id, {
        serialNo: newSerialNo,
        installDate: payload.date,
        syncStatus,
        updatedAt: now,
      } as never);
      // 原设备停用（历次标定跟原序列号走，不删除）
      const oldDevice = await db.instruments.where('serialNo').equals(oldSerialNo).first();
      if (oldDevice) {
        await db.instruments.update(oldDevice.id, { state: '已停用', updatedAt: now } as never);
      }
      // 更换记录
      await db.replaces.put({
        id: createId('rpl'),
        installationId: installation.id,
        reason: payload.reason.trim(),
        oldSerialNo,
        newSerialNo,
        date: payload.date,
        state: '待更换',
        operator: payload.operator.trim(),
        remark: syncStatus === '待认' ? '新序列号待计量站认账' : '',
        createdAt: now,
        updatedAt: now,
      });
    });
    return { installationId: installation.id, oldSerialNo, newSerialNo, syncStatus };
  }
);

/**
 * 对账：把安装位与计量站台账按序列号对齐。
 * 只把「待认」推进为「已认」，不把已认退回待认（认过的结果不退回）。
 * 重试安全：重复执行不会回退已认结果。
 */
export const reconcileInstallations = createAsyncThunk(
  'instrument/reconcileInstallations',
  async () => {
    const now = Date.now();
    const [installations, instruments] = await Promise.all([
      db.installations.toArray(),
      db.instruments.toArray(),
    ]);
    const knownSerials = new Set(instruments.map((ins) => ins.serialNo));
    let promoted = 0;
    await db.installations.toCollection().modify((row) => {
      if (row.syncStatus === '待认' && knownSerials.has(row.serialNo)) {
        row.syncStatus = '已认';
        row.updatedAt = now;
        promoted += 1;
      }
    });
    return { promoted, total: installations.length };
  }
);

/** 认过：手动把待认安装位确认为已认（认过不退回） */
export const acknowledgeInstallation = createAsyncThunk(
  'instrument/acknowledgeInstallation',
  async (installationId: string) => {
    const now = Date.now();
    await db.installations.update(installationId, { syncStatus: '已认', updatedAt: now } as never);
    return installationId;
  }
);

/**
 * 补建物理仪器：待认安装位的新序列号在计量站台账缺失时，
 * 按登记的型号补建物理仪器，随后对账自动认过。
 */
export const createMissingInstrument = createAsyncThunk(
  'instrument/createMissingInstrument',
  async (payload: { installationId: string; type: InstrumentType; model: string }, { rejectWithValue }) => {
    const now = Date.now();
    const installation = await db.installations.get(payload.installationId);
    if (!installation) return rejectWithValue('安装位不存在');
    const serialNo = installation.serialNo;
    const conflict = await findSerialConflict(serialNo);
    if (conflict) return rejectWithValue(`序列号「${serialNo}」已存在`);
    const instrument: Instrument = {
      id: instrumentIdOf(serialNo),
      serialNo,
      type: payload.type,
      model: payload.model.trim(),
      state: '在用',
      qualifyExpiryDate: qualifyExpiryDateOf(null, installation.installDate),
      remark: '补建：换机后新序列号待计量站认账',
      createdAt: now,
      updatedAt: now,
    };
    await db.transaction('rw', [db.instruments, db.installations], async () => {
      await db.instruments.put(instrument);
      await db.installations.update(installation.id, { syncStatus: '已认', updatedAt: now } as never);
    });
    return { instrument, installationId: installation.id };
  }
);

/** 删除安装位（物理仪器与历次标定保留，跟原序列号走） */
export const removeInstallation = createAsyncThunk(
  'instrument/removeInstallation',
  async (installationId: string) => {
    await db.transaction('rw', [db.installations, db.replaces], async () => {
      await db.replaces.where('installationId').equals(installationId).delete();
      await db.installations.delete(installationId);
    });
    return installationId;
  }
);

/** 删除物理仪器：级联删除其历次标定；引用它的安装位转为待认（设备已不在台账） */
export const removeInstrument = createAsyncThunk(
  'instrument/removeInstrument',
  async (instrumentId: string) => {
    const instrument = await db.instruments.get(instrumentId);
    const now = Date.now();
    await db.transaction('rw', [db.instruments, db.calibrations, db.installations], async () => {
      await db.calibrations.where('instrumentId').equals(instrumentId).delete();
      await db.instruments.delete(instrumentId);
      if (instrument) {
        await db.installations
          .where('serialNo')
          .equals(instrument.serialNo)
          .modify((row) => {
            row.syncStatus = '待认';
            row.updatedAt = now;
          });
      }
    });
    return instrumentId;
  }
);

/** 批量改状态（如把超期仪器统一置为待标定） */
export const bulkSetInstrumentState = createAsyncThunk(
  'instrument/bulkSetInstrumentState',
  async (payload: { ids: string[]; state: InstrumentState }) => {
    const now = Date.now();
    await db.instruments
      .where('id')
      .anyOf(payload.ids)
      .modify((row) => {
        row.state = payload.state;
        row.updatedAt = now;
      });
    return payload;
  }
);

const instrumentSlice = createSlice({
  name: 'instrument',
  initialState,
  reducers: {
    setInstruments(state, action: PayloadAction<Instrument[]>) {
      state.instruments = action.payload;
      state.ready = true;
      state.error = null;
    },
    setInstallations(state, action: PayloadAction<Installation[]>) {
      state.installations = action.payload;
    },
    setInstrumentError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    selectStationForInstrument(state, action: PayloadAction<string | null>) {
      state.currentStationId = action.payload;
      state.draft.stationId = action.payload ?? '';
    },
    patchDraft(state, action: PayloadAction<Partial<InstrumentDraft>>) {
      state.draft = { ...state.draft, ...action.payload };
    },
    resetDraft(state) {
      state.draft = { ...createEmptyInstrumentDraft(), stationId: state.currentStationId ?? '' };
    },
    setReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createInstrument.fulfilled, (state, action) => {
        state.lastReceipt = `仪器已登记：安装位「${action.payload.installation.channel}」，序列号 ${action.payload.instrument.serialNo}`;
        state.error = null;
      })
      .addCase(createInstrument.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '仪器登记失败';
      })
      .addCase(swapInstrument.fulfilled, (state, action) => {
        state.lastReceipt =
          action.payload.syncStatus === '已认'
            ? `换机完成：安装位保留，序列号已落到 ${action.payload.newSerialNo}，原设备历次标定随原序列号保留`
            : `换机完成：新序列号 ${action.payload.newSerialNo} 尚未在计量站台账登记，已挂台账待认，认过才算数`;
        state.error = null;
      })
      .addCase(swapInstrument.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '换机失败';
      })
      .addCase(reconcileInstallations.fulfilled, (state, action) => {
        state.lastReceipt = `对账完成：${action.payload.promoted} 条待认安装位已认账（已认结果不退回）`;
      })
      .addCase(acknowledgeInstallation.fulfilled, (state) => {
        state.lastReceipt = '已认过：该安装位与计量站台账一致';
      })
      .addCase(createMissingInstrument.fulfilled, (state, action) => {
        state.lastReceipt = `已补建物理仪器 ${action.payload.instrument.serialNo}，安装位已认账`;
      })
      .addCase(createMissingInstrument.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '补建仪器失败';
      })
      .addCase(removeInstallation.fulfilled, (state, action) => {
        state.lastReceipt = `已删除安装位 ${action.payload}，物理仪器与历次标定保留`;
      })
      .addCase(removeInstrument.fulfilled, (state, action) => {
        state.lastReceipt = `已删除物理仪器 ${action.payload} 及其历次标定，引用安装位已转待认`;
      })
      .addCase(updateInstrument.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '仪器更新失败';
      });
  },
});

export const {
  setInstruments,
  setInstallations,
  setInstrumentError,
  selectStationForInstrument,
  patchDraft,
  resetDraft,
  setReceipt,
} = instrumentSlice.actions;

let started = false;

/** 启动物理仪器与安装位表实时订阅（幂等） */
export function startInstrumentSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<Instrument>(() => db.instruments).subscribe((rows) => {
    dispatch(setInstruments(rows));
  });
  watchTable<Installation>(() => db.installations).subscribe((rows) => {
    dispatch(setInstallations(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectInstrumentState = (state: WithInstrument): InstrumentSliceState => state.instrument;
export const selectInstruments = (state: WithInstrument): Instrument[] => state.instrument.instruments;
export const selectInstallations = (state: WithInstrument): Installation[] => state.instrument.installations;
export const selectInstrumentReady = (state: WithInstrument): boolean => state.instrument.ready;
export const selectInstrumentDraft = (state: WithInstrument): InstrumentDraft => state.instrument.draft;
export const selectInstrumentReceipt = (state: WithInstrument): string => state.instrument.lastReceipt;

export const selectInstrumentById = (
  state: WithInstrument,
  id: string | null | undefined
): Instrument | null => (id ? state.instrument.instruments.find((row) => row.id === id) ?? null : null);

export const selectInstrumentBySerial = (
  state: WithInstrument,
  serialNo: string | null | undefined
): Instrument | null =>
  serialNo ? state.instrument.instruments.find((row) => row.serialNo === serialNo) ?? null : null;

export const selectInstallationsOfStation = (
  state: WithInstrument,
  stationId: string | null | undefined
): Installation[] => {
  if (!stationId) return [];
  return state.instrument.installations
    .filter((row) => row.stationId === stationId)
    .sort((a, b) => a.channel.localeCompare(b.channel, 'zh-Hans-CN'));
};

/** 安装位当前在位数物理仪器（仅已认安装位参与） */
export const selectCurrentDeviceOfInstallation = (
  state: WithInstrument,
  installation: Installation | null | undefined
): Instrument | null => {
  if (!installation || installation.syncStatus !== '已认') return null;
  return (
    state.instrument.instruments.find((row) => row.serialNo === installation.serialNo) ?? null
  );
};

/** 台站当前在位数设备（按安装位通道排序） */
export const selectDevicesOfStation = (
  state: WithInstrument,
  stationId: string | null | undefined
): Instrument[] => {
  if (!stationId) return [];
  return state.instrument.installations
    .filter((row) => row.stationId === stationId && row.syncStatus === '已认')
    .sort((a, b) => a.channel.localeCompare(b.channel, 'zh-Hans-CN'))
    .map((row) => state.instrument.instruments.find((ins) => ins.serialNo === row.serialNo))
    .filter((ins): ins is Instrument => Boolean(ins));
};

/** 台站 id → 安装位数 */
export const selectInstallationCountsByStation = (state: WithInstrument): Record<string, number> => {
  const counts: Record<string, number> = {};
  state.instrument.installations.forEach((row) => {
    counts[row.stationId] = (counts[row.stationId] ?? 0) + 1;
  });
  return counts;
};

/** 台站 id → 物理仪器台数（当前在位数，已认安装位） */
export const selectInstrumentCountsByStation = (state: WithInstrument): Record<string, number> => {
  const counts: Record<string, number> = {};
  state.instrument.installations
    .filter((row) => row.syncStatus === '已认')
    .forEach((row) => {
      counts[row.stationId] = (counts[row.stationId] ?? 0) + 1;
    });
  return counts;
};

/** 待认安装位数（对账缺口） */
export const selectPendingSyncCount = (state: WithInstrument): number =>
  state.instrument.installations.filter((row) => row.syncStatus === '待认').length;

/** 仪器类型统计（物理仪器口径） */
export const selectInstrumentTypeCounts = (state: WithInstrument): Record<InstrumentType, number> => {
  const counts: Record<InstrumentType, number> = { 宽频带: 0, 短周期: 0, 强震: 0 };
  state.instrument.instruments.forEach((row) => {
    counts[row.type] += 1;
  });
  return counts;
};

export default instrumentSlice.reducer;
