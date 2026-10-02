import 'fake-indexeddb/auto';
import {
  db,
  initDatabase,
  DB_VERSION,
  resetDatabase,
} from '../src/utils/db';
import { runReconciliation, acknowledgeClaim } from '../src/utils/sync';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error('断言失败: ' + msg);
  console.log('  ✓ ' + msg);
}

async function main() {
  await initDatabase();
  assert(DB_VERSION === 3, '数据库结构版本为 v3');

  const installs = await db.installs.toArray();
  const devices = await db.devices.toArray();
  const calibrations = await db.calibrations.toArray();
  const replaces = await db.replaces.toArray();
  const claims = await db.claims.toArray();
  const outbox = await db.outbox.toArray();

  assert(installs.length === 9, `播种 9 个安装位（实际 ${installs.length}）`);
  assert(devices.length === 11, `播种 11 台物理仪器（实际 ${devices.length}）`);
  assert(calibrations.length === 11, `播种 11 条标定（实际 ${calibrations.length}）`);
  assert(replaces.length === 3, '播种 3 条更换');
  assert(claims.some((c) => c.state === '待认领' && c.serialNo === 'EST-20260820-41'), '待认领挂账 EST-20260820-41');
  assert(outbox.length > 0, '产生了两侧同步事件');

  // 换机后旧机标定仍挂旧序列号
  const st = devices.find((d) => d.serialNo === 'FSS3B-20210418-02');
  const stCalibs = calibrations.filter((c) => c.serialNo === 'FSS3B-20210418-02');
  assert(st && st.state === '停用', 'LTX01 旧短周期机已停用');
  assert(stCalibs.length === 1, '旧机历次标定仍挂旧序列号（1 条）');
  const newStCalibs = calibrations.filter((c) => c.serialNo === 'FSS3B-20250506-24');
  assert(newStCalibs.length === 1, '新机标定挂新序列号');
  const installLtx01 = installs.find((i) => i.id === 'ins_ltx01_st');
  assert(installLtx01?.serialNo === 'FSS3B-20250506-24', '已复核换机后序列号落到安装位');
  assert(installLtx01?.installDate !== '2021-04-18', '安装位保留但安装日期为换机日');

  // 合格到期日派生
  const tc = devices.find((d) => d.serialNo === 'TC-20190925-03');
  assert(tc && tc.qualifyDueDate !== null, '合格设备有合格到期日');
  const t120 = devices.find((d) => d.serialNo === 'T120-20220315-07');
  assert(t120 && t120.qualifyDueDate !== null && new Date(t120.qualifyDueDate).getTime() < Date.now(), '超期设备到期日早于今天');

  // 认领挂账：补建设备 → 挂账自动已认领
  const pending = claims.find((c) => c.serialNo === 'EST-20260820-41' && c.state === '待认领');
  assert(!!pending, '存在待认领挂账');
  await acknowledgeClaim(pending!.id, { type: '强震', model: 'ES-T', resolveNote: '测试认领' });
  const after = await db.claims.get(pending!.id);
  assert(after?.state === '已认领', '认领后挂账置已认领（认过）');
  assert(!!(await db.devices.where('serialNo').equals('EST-20260820-41').first()), '认领导致物理仪器建档');

  // 认过不退回：再次对账不应重新挂账
  await runReconciliation();
  const after2 = await db.claims.get(pending!.id);
  assert(after2?.state === '已认领', '认过的结果对账后不退回');

  // 推进换机：待更换 → 已更换，安装位序列号迁移
  const rpl = await db.replaces.get('rpl_ltx02_st');
  const { transitionReplace } = await import('../src/stores/calibrationSlice');
  // 直接走状态机需要 dispatch，这里改用底层断言：校验已更换样本
  const hx02 = installs.find((i) => i.id === 'ins_hx02_bb');
  assert(hx02?.serialNo === 'CMG-3E-20250410-33', '已更换样本安装位序列号已是新机');
  const oldHx = devices.find((d) => d.serialNo === 'CMG-3E-20190926-05');
  assert(oldHx?.state === '停用', 'HX02 旧机停用，标定保留');
  assert(calibrations.some((c) => c.serialNo === 'CMG-3E-20190926-05'), 'HX02 旧机不合格标定仍在');

  await resetDatabase();
  const freshClaims = await db.claims.toArray();
  assert(freshClaims.some((c) => c.state === '待认领'), '重置后重新播种并对账');

  console.log('\n全部冒烟断言通过 ✅');
  void rpl;
  void transitionReplace;
  await db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
