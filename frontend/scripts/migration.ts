import 'fake-indexeddb/auto';
import Dexie from 'dexie';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error('断言失败: ' + msg);
  console.log('  ✓ ' + msg);
}

/** 1) 手工建一个 v2 结构的旧库 */
async function seedLegacyV2(): Promise<void> {
  const legacy = new Dexie('gbseisarray');
  legacy.version(2).stores({
    arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
    stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
    instruments: 'id, stationId, type, model, serialNo, installDate, state, updatedAt',
    calibrations: 'id, instrumentId, date, sensitivity, selfNoise, responseVerdict, updatedAt',
    replaces: 'id, instrumentId, state, date, newSerialNo, updatedAt',
  });
  await legacy.table('arrays').put({ id: 'arr_1', name: '旧台阵', stationCount: 1, state: '运行中', apertureKm: 1, deployDate: '2020-01-01', department: '', createdAt: 1, updatedAt: 1 });
  await legacy.table('stations').put({ id: 'stn_1', arrayId: 'arr_1', code: 'OLD1', lat: 30, lng: 103, elevM: 10, bedrock: '花岗岩', siteNote: '', createdAt: 1, updatedAt: 1 });
  await legacy.table('instruments').bulkPut([
    { id: 'ins_1', stationId: 'stn_1', type: '宽频带', model: 'CMG-3ESPC', serialNo: 'SN-OLD-1', installDate: '2020-02-02', state: '在用', remark: '', createdAt: 1, updatedAt: 1 },
    // 旧数据缺序列号归属
    { id: 'ins_2', stationId: 'stn_1', type: '短周期', model: 'FSS-3B', serialNo: '', installDate: '2020-03-03', state: '待标定', remark: '老记录没抄序列号', createdAt: 1, updatedAt: 1 },
  ]);
  await legacy.table('calibrations').bulkPut([
    { id: 'cal_1', instrumentId: 'ins_1', date: '2024-01-10', sensitivity: 1500, selfNoise: 1.8, responseVerdict: '合格', operator: '甲', agency: '计量站', remark: '', createdAt: 1, updatedAt: 1 },
    { id: 'cal_2', instrumentId: 'ins_2', date: '2023-01-10', sensitivity: 400, selfNoise: 2.0, responseVerdict: '合格', operator: '乙', agency: '计量站', remark: '', createdAt: 1, updatedAt: 1 },
  ]);
  await legacy.table('replaces').put({ id: 'rpl_1', instrumentId: 'ins_1', reason: '升级', newSerialNo: 'SN-NEW-1', date: '2025-01-01', state: '待更换', operator: '丙', remark: '', createdAt: 1, updatedAt: 1 });
  await legacy.close();
}

async function main() {
  await seedLegacyV2();

  // 2) 打开正式 db 触发 v2→v3 迁移
  const { db, initDatabase } = await import('../src/utils/db');
  await initDatabase();

  const installs = await db.installs.toArray();
  const devices = await db.devices.toArray();
  const calibrations = await db.calibrations.toArray();
  const replaces = await db.replaces.toArray();

  assert(installs.length === 2, '旧 instruments 两行拆成两个安装位');
  assert(devices.length === 2, '旧 instruments 两行拆成两台物理仪器');
  const i1 = installs.find((i) => i.id === 'ins_1');
  assert(i1?.serialNo === 'SN-OLD-1', '正常记录序列号保留');
  assert(i1?.channel === '未登记通道', '旧数据缺通道，补「未登记通道」');
  const i2 = installs.find((i) => i.id === 'ins_2');
  assert(i2 && i2.serialNo.startsWith('补登-'), `缺序列号旧记录先补登占位（${i2?.serialNo}）`);
  assert(i2?.state === '待标定', '安装位状态映射正确');

  const c1 = calibrations.find((c) => c.id === 'cal_1');
  assert(c1?.serialNo === 'SN-OLD-1', '标定 instrumentId 改挂序列号');
  const c2 = calibrations.find((c) => c.id === 'cal_2');
  assert(c2 && c2.serialNo.startsWith('补登-'), '缺序列号设备的标定补挂到占位序列号');

  const dev1 = devices.find((d) => d.serialNo === 'SN-OLD-1');
  assert(dev1?.qualifyDueDate === '2025-01-09' || dev1?.qualifyDueDate === '2025-01-10', `合格到期日按标定回填（${dev1?.qualifyDueDate}）`);

  const rpl = replaces[0];
  assert(rpl.installId === 'ins_1' && rpl.fromSerialNo === 'SN-OLD-1', '更换改挂安装位并记下旧序列号');

  // 3) 补登的占位序列号因为设备表已建同号档，不会再挂待认领；通道待补可见
  const claims = await db.claims.toArray();
  assert(claims.every((c) => c.state !== '待认领' || !c.serialNo.startsWith('补登-')), '补登占位序列号有设备归属，不再挂待认领账');

  console.log('\nv2→v3 迁移断言全部通过 ✅');
  await db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
