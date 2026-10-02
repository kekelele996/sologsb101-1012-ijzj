# sologsb101-1012 地震台阵仪器标定与布设台账

面向地震台阵建设与运维班组、计量站的纯前端单页应用：**运维班组按安装位、计量站按序列号各维护一份台账**，
把台站布设、仪器安装、逐次标定与两侧对账写成可追溯的记录。数据全部保存在浏览器本地（IndexedDB），
不依赖任何后端服务或外部接口。

## 一、两份台账怎么分

旧台账把「物理仪器（型号、序列号、历次标定）」和「安装位置（台站、通道、装机日）」挤在同一条记录里，
台站换过仪器后早先的标定还挂在原处，说不清测的是哪台设备。v3 起拆成两份：

| 台账 | 维护方 | 表 | 记录内容 | 换机时 |
| --- | --- | --- | --- | --- |
| 安装位台账 | 运维班组 | `installs` | 台站、**通道**、安装日期、当前序列号、运行状态 | **安装位保留，只把序列号改成新的一台**，安装日期记为换机日 |
| 物理仪器台账 | 计量站 | `devices` / `calibrations` | 序列号、类型、型号、**历次标定**、**合格到期日** | 旧序列号的历次标定不动，新机按新序列号重新累积 |

关联规则：

- **序列号是两份台账唯一的业务键**：安装位填的 `serialNo` 必须能在计量站设备表里找到。
- 标定记录挂在 `calibrations.serialNo` 上，换机不带走、不串台；合格到期日 = 最近一次合格标定日 + 365 天。
- **台站卡片与几何页的合格率、超期、不合格统计，一律按安装位「当前那台」设备的标定重算**；换机后旧机标定不再计入该台站。
- 删除台站 / 安装位只删运维侧记录，物理仪器档案与其历次标定在计量侧保留。

## 二、序列号对不上：先挂账，认过才算数

运维先装了设备、而计量站还没建档（或标定记录的序列号无档案）时：

1. 序列号**先摆进挂账表 `claims`，并写清台站、台阵、通道与来源**（安装位 / 标定记录），运维侧安装位照常保存；
2. 计量站在「序列号对账」页核对铭牌后**认领并补建物理仪器档案，认过才算数**；也可驳回（序列号确实有误）；
3. **认过的结果不退回**：已认领 / 已驳回的挂账不会因重新对账复活。

## 三、两侧同步失败：各按本侧重试

两侧各写各的，通过 `outbox` 同步事件对账（`serial-pending` / `serial-resolved` / `qualify-due`）：

- 事件带发起侧（`ops` 运维 / `metro` 计量）；`failed` 事件只由**发起侧**重试，不被另一侧带走；
- 投递成功即标记 `acknowledged`，**认过不退回**；对账与推送均幂等（按 `side:kind:serialNo` 去重）。

## 四、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22812**

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

## 五、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18.3（函数组件 + Hooks） | 页面全部 `lazy` 懒加载并 `Suspense` 兜底 |
| 语言 | TypeScript 5.6（strict） | 构建脚本执行 `tsc --noEmit` 类型检查 |
| UI 组件 | Ant Design 5.22 + @ant-design/icons | 中文语言包，表格 / 表单 / Modal / 徽标 |
| 构建 | Vite 5 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Redux Toolkit 2 + react-redux 9 | `arraySlice` / `installSlice` / `deviceSlice` / `calibrationSlice` |
| 路由 | React Router 6（`createBrowserRouter`） | 支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB，库名 `gbseisarray`） | 结构版本 **v3** + upgrade 迁移 + liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建 |

## 六、路由与功能模块

| 路由 | 页面 | 维护方 | 主要内容 |
| --- | --- | --- | --- |
| `/arrays` | 台阵与台站台账 | 运维 | 台阵 / 台站增删改、孔径重算；卡片显示安装位数与**当前设备合格率、待认领数** |
| `/stations/:id/instruments` | 台站安装位 | 运维 | 按台站记**通道、安装日期、当前序列号**；换机只改序列号；未知序列号橙色挂账标记 |
| `/devices` | 物理仪器档案 | 计量站 | 按序列号建档、型号 / 状态 / 合格到期日；查看每台设备换机前后完整标定历史 |
| `/calibrations` | 标定记录台 | 计量站 | 按序列号录入标定、自动初判、回写合格到期日、灵敏度趋势 |
| `/replacements` | 合格评定与更换 | 两侧 | 按安装位当前设备评定；换机状态机 待更换→已更换→已复核 |
| `/claims` | 序列号对账与同步 | 两侧 | 挂账认领 / 驳回、查看与按侧重试同步事件 |
| `/geometry` | 几何视图与备份 | — | 孔径 / 台间距、按安装位当前设备汇总合格率、八表 JSON 导入导出 |

换机状态机：流转到「已更换」时**安装位保留、序列号落到新机、安装日期改为换机日**，旧机在计量侧置停用但标定保留；
回退状态不回滚已认过的序列号归属。

## 七、数据存储与升级（v2 → v3）

- 数据库 `gbseisarray`，当前结构版本 **v3**，共八张表：
  `arrays`、`stations`、`installs`、`devices`、`calibrations`、`replaces`、`claims`、`outbox`。
- v3 升级迁移自动完成：
  - 旧 `instruments` 一行拆成 `installs`（安装位，旧数据无通道则补「未登记通道」）+ `devices`（物理仪器）；
  - `calibrations.instrumentId` 改挂 `serialNo`；`replaces` 改挂 `installId` 并记下被换下的 `fromSerialNo`；
  - **旧数据缺序列号归属的，先补一个「补登-型号-xxx」占位序列号**，保证标定有归属，设备备注里留痕待计量站核实；
  - 设备合格到期日按最近一次合格标定回填。
- 首屏播种：2 台阵 / 5 台站 / 9 安装位 / 11 台物理仪器 / 11 条标定 / 3 条更换，并刻意含
  已复核换机（旧机标定保留）、已更换待复核、待更换、不合格标定、超期设备与 1 条待认领序列号。
- `/geometry` 页可导出八表 JSON 快照，支持「覆盖导入」与「追加导入」；追加导入重发运维侧主键，
  **序列号作为业务键保持不变**（标定才能继续跟对设备）。

## 八、本地开发与测试

```bash
cd frontend
npm install
npm run dev        # http://localhost:22812
npm run build      # 类型检查 + 生产构建
npm run typecheck  # 仅类型检查
```

`scripts/` 下有用 fake-indexeddb 跑在 Node 里的无浏览器校验脚本（esbuild 打包后直接 `node` 运行）：

```bash
npx esbuild scripts/smoke.ts        --bundle --platform=node --format=cjs --outfile=/tmp/s.cjs && node /tmp/s.cjs   # 播种/挂账/换机后归属
npx esbuild scripts/migration.ts    --bundle --platform=node --format=cjs --outfile=/tmp/m.cjs && node /tmp/m.cjs   # v2→v3 拆分与缺序列号补登
npx esbuild scripts/replace-flow.ts --bundle --platform=node --format=cjs --outfile=/tmp/r.cjs && node /tmp/r.cjs   # 换机状态机端到端
npx esbuild scripts/qualify-sync.ts --bundle --platform=node --format=cjs --outfile=/tmp/q.cjs && node /tmp/q.cjs   # 合格率重算 + 各按本侧重试
```

- **离线可用**：纯静态资源、无网络请求；换浏览器或清空站点数据需通过 JSON 备份迁移。
