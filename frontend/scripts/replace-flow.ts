import 'fake-indexeddb/auto';
import Dexie from 'dexie';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error('断言失败: ' + msg);
  console.log('  ✓ ' + msg);
}

/** mini 执行器：actionCreator(arg) 返回经典 thunk (dispatch, getState) => Promise */
async function runThunk<T>(
  actionCreator: (arg: T) => (
    dispatch: (action: unknown) => unknown,
    getState: () => Record<string, unknown>
  ) => Promise<unknown>,
  arg: T
): Promise<unknown> {
  const dispatch = (action: unknown) => {
    const a = action as { type?: string; payload?: unknown; error?: unknown };
    if (a && typeof a === 'object' && typeof a.type === 'string' && a.type.endsWith('/rejected')) {
      throw new Error(String(a.payload ?? a.error ?? 'thunk rejected'));
    }
    return action;
  };
  const thunk = actionCreator(arg);
  return thunk(dispatch, () => ({}));
}

async function main() {
  const { db, initDatabase } = await import('../src/utils/db');
  await initDatabase();
  const { transitionReplace } = await import('../src/stores/calibrationSlice');
  const { acknowledgeClaim } = await import('../src/utils/sync');

  // LTX02 短周期待更换：新序列号 L4C-20250301-21 已在设备表（库存）
  await runThunk(transitionReplace, { id: 'rpl_ltx02_st', next: '已更换' });

  const install = await db.installs.get('ins_ltx02_st');
  assert(install?.serialNo === 'L4C-20250301-21', '换机后安装位序列号落到新机');
  assert(install?.state === '待标定', '换机后安装位置待标定（等安装后首次标定）');
  assert(install?.installDate !== '2022-03-15', '安装日期更新为换机日');
  const oldDev = await db.devices.where('serialNo').equals('L4C-20220315-08').first();
  assert(oldDev?.state === '停用', '旧机计量档案置停用');
  const oldCalibs = await db.calibrations.where('serialNo').equals('L4C-20220315-08').count();
  assert(oldCalibs === 1, '旧机历次标定仍挂旧序列号，不带走');
  const newDev = await db.devices.where('serialNo').equals('L4C-20250301-21').first();
  assert(newDev?.state === '在用', '库存新机换机后置在用');

  // 安装位序列号已在设备档案 → 无新挂账
  const pendingForNew = await db.claims
    .where('serialNo')
    .equals('L4C-20250301-21')
    .and((c) => c.state === '待认领')
    .count();
  assert(pendingForNew === 0, '新序列号有档案，不产生挂账');

  // 已复核
  await runThunk(transitionReplace, { id: 'rpl_ltx02_st', next: '已复核' });
  const install2 = await db.installs.get('ins_ltx02_st');
  assert(install2?.state === '在用', '复核后安装位回在用');

  // 回退到待更换：已认过的序列号不退回
  await runThunk(transitionReplace, { id: 'rpl_ltx02_st', next: '待更换' });
  const install3 = await db.installs.get('ins_ltx02_st');
  assert(install3?.serialNo === 'L4C-20250301-21', '状态回退但序列号归属不退回');

  // 模拟运维直接改安装位序列号为一个不存在的号 → 产生挂账；随后计量建档认领
  const { updateInstall } = await import('../src/stores/installSlice');
  await runThunk(updateInstall, { id: 'ins_ltx03_bb', patch: { serialNo: 'UNKNOWN-SN-999' } });
  const claim = await db.claims
    .where('serialNo')
    .equals('UNKNOWN-SN-999')
    .and((c) => c.state === '待认领')
    .first();
  assert(!!claim, '运维写入未知序列号 → 挂账写清台站');
  assert(claim?.stationCode === 'LTX03', '挂账写清台站码 LTX03');

  await acknowledgeClaim(claim!.id, { type: '宽频带', model: 'STS-2.5' });
  const claimAfter = await db.claims.get(claim!.id);
  assert(claimAfter?.state === '已认领', '计量建档后挂账认过');
  const created = await db.devices.where('serialNo').equals('UNKNOWN-SN-999').first();
  assert(!!created && created.model === 'STS-2.5', '认领补建物理仪器档案');

  // 已认领不能重复认领（认过不退回）
  let threw = false;
  try {
    await acknowledgeClaim(claim!.id, { type: '强震', model: 'X' });
  } catch {
    threw = true;
  }
  assert(threw, '对已认过挂账再次认领会被拒绝');

  console.log('\n换机状态机与挂账端到端断言全部通过 ✅');
  await db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
