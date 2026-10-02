/**
 * 安装位 slice（运维班组维护）：
 * 按台站记安装位、通道、安装日期、当前序列号。换机只改 serialNo，行保留。
 * 序列号在计量站无档案时，保存后由对账流程挂账（写清台站，认过才算数）。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import { runReconciliation } from '@/utils/sync';
import type { Install, InstallDraft, InstallState } from '@/types/install';
import { createEmptyInstallDraft } from '@/types/install';
import type { RootState } from '@/stores/store';

type WithInstall = RootState;

export interface InstallSliceState {
  installs: Install[];
  ready: boolean;
  error: string | null;
  /** 当前选中的台站（台站安装位页上下文） */
  currentStationId: string | null;
  /** 安装位登记草稿 */
  draft: InstallDraft;
  /** 最近一次保存回执 */
  lastReceipt: string;
}

const initialState: InstallSliceState = {
  installs: [],
  ready: false,
  error: null,
  currentStationId: null,
  draft: createEmptyInstallDraft(),
  lastReceipt: '',
};

export const createInstall = createAsyncThunk(
  'install/createInstall',
  async (payload: Omit<Install, 'id' | 'createdAt' | 'updatedAt'>) => {
    const now = Date.now();
    const row: Install = { ...payload, serialNo: payload.serialNo.trim(), id: createId('ins'), createdAt: now, updatedAt: now };
    await db.installs.put(row);
    // 序列号对不上先挂账（写清台站），认过才算数
    const result = await runReconciliation();
    return { row, pendingCreated: result.created };
  }
);

export const updateInstall = createAsyncThunk(
  'install/updateInstall',
  async (payload: { id: string; patch: Partial<Install> }) => {
    const patch = { ...payload.patch };
    if (typeof patch.serialNo === 'string') patch.serialNo = patch.serialNo.trim();
    await db.installs.update(payload.id, { ...patch, updatedAt: Date.now() } as never);
    const result = await runReconciliation();
    return { ...payload, pendingCreated: result.created };
  }
);

/** 删除安装位：级联删除更换记录与未认领挂账；物理仪器和标定不动 */
export const removeInstall = createAsyncThunk(
  'install/removeInstall',
  async (installId: string) => {
    await db.transaction('rw', [db.installs, db.replaces, db.claims], async () => {
      await db.replaces.where('installId').equals(installId).delete();
      const pendingKeys = await db.claims
        .where('installId')
        .equals(installId)
        .and((claim) => claim.state === '待认领')
        .primaryKeys();
      if (pendingKeys.length > 0) await db.claims.bulkDelete(pendingKeys);
      await db.installs.delete(installId);
    });
    return installId;
  }
);

/** 批量改安装位运行状态（如把超期通道统一置为待标定） */
export const bulkSetInstallState = createAsyncThunk(
  'install/bulkSetInstallState',
  async (payload: { ids: string[]; state: InstallState }) => {
    const now = Date.now();
    await db.installs
      .where('id')
      .anyOf(payload.ids)
      .modify((row) => {
        row.state = payload.state;
        row.updatedAt = now;
      });
    return payload;
  }
);

const installSlice = createSlice({
  name: 'install',
  initialState,
  reducers: {
    setInstalls(state, action: PayloadAction<Install[]>) {
      state.installs = action.payload;
      state.ready = true;
      state.error = null;
    },
    setInstallError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    selectStationForInstall(state, action: PayloadAction<string | null>) {
      state.currentStationId = action.payload;
      state.draft.stationId = action.payload ?? '';
    },
    patchDraft(state, action: PayloadAction<Partial<InstallDraft>>) {
      state.draft = { ...state.draft, ...action.payload };
    },
    resetDraft(state) {
      state.draft = { ...createEmptyInstallDraft(), stationId: state.currentStationId ?? '' };
    },
    setReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createInstall.fulfilled, (state, action) => {
        state.lastReceipt =
          action.payload.pendingCreated > 0
            ? '安装位已登记，但该序列号计量站尚无档案，已挂账待认领（认过才算数）'
            : '安装位已登记，序列号与计量站档案一致';
        state.error = null;
      })
      .addCase(createInstall.rejected, (state, action) => {
        state.error = action.error.message ?? '安装位登记失败';
      })
      .addCase(updateInstall.rejected, (state, action) => {
        state.error = action.error.message ?? '安装位更新失败';
      })
      .addCase(removeInstall.fulfilled, (state, action) => {
        state.lastReceipt = `已删除安装位 ${action.payload}（物理仪器与标定保留）`;
      });
  },
});

export const {
  setInstalls,
  setInstallError,
  selectStationForInstall,
  patchDraft,
  resetDraft,
  setReceipt,
} = installSlice.actions;

let started = false;

/** 启动安装位表实时订阅（幂等） */
export function startInstallSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<Install>(() => db.installs).subscribe((rows) => {
    dispatch(setInstalls(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectInstallState = (state: WithInstall): InstallSliceState => state.install;
export const selectInstalls = (state: WithInstall): Install[] => state.install.installs;
export const selectInstallReady = (state: WithInstall): boolean => state.install.ready;
export const selectInstallDraft = (state: WithInstall): InstallDraft => state.install.draft;
export const selectInstallReceipt = (state: WithInstall): string => state.install.lastReceipt;

export const selectInstallById = (
  state: WithInstall,
  id: string | null | undefined
): Install | null => (id ? state.install.installs.find((row) => row.id === id) ?? null : null);

export const selectInstallsOfStation = (
  state: WithInstall,
  stationId: string | null | undefined
): Install[] => {
  if (!stationId) return [];
  return state.install.installs
    .filter((row) => row.stationId === stationId)
    .sort((a, b) => a.channel.localeCompare(b.channel, 'zh-Hans-CN'));
};

/** 台站 id → 安装位数 */
export const selectInstallCountsByStation = (state: WithInstall): Record<string, number> => {
  const counts: Record<string, number> = {};
  state.install.installs.forEach((row) => {
    counts[row.stationId] = (counts[row.stationId] ?? 0) + 1;
  });
  return counts;
};

export default installSlice.reducer;
