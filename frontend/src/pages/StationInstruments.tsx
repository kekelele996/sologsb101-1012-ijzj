/**
 * 运维班组：/stations/:id/instruments 台站安装位维护
 * 按台站记安装位、通道、安装日期、当前序列号；换机只换序列号，安装位保留。
 * 序列号在计量站无档案时先挂账（写清台站，认过才算数）。
 * 台站卡片合格率按安装位当前那台设备的标定重算。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  App as AntdApp,
  Breadcrumb,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Col,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, SyncOutlined, WarningFilled } from '@ant-design/icons';
import dayjs from 'dayjs';
import FilterBar from '@/components/common/FilterBar';
import type { FilterModel } from '@/types/filter';
import StatBadge from '@/components/common/StatBadge';
import QualifyTag from '@/components/common/QualifyTag';
import EmptyPanel from '@/components/common/EmptyPanel';
import RouteMissingPanel from '@/components/common/RouteMissingPanel';
import { ROUTES } from '@/router';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import {
  createStation,
  patchStationFilter,
  recomputeAperture,
  removeStation,
  resetStationFilter,
  selectArrayById,
  selectArrayReady,
  selectArrays,
  selectStationFilter,
  selectStationsOfArray,
  updateStation,
} from '@/stores/arraySlice';
import {
  bulkSetInstallState,
  createInstall,
  patchDraft,
  removeInstall,
  resetDraft,
  selectInstalls,
  selectInstallsOfStation,
  updateInstall,
} from '@/stores/installSlice';
import { selectDevices } from '@/stores/deviceSlice';
import { selectCalibrations, selectClaims } from '@/stores/calibrationSlice';
import { BEDROCK_TYPES, validateLatLng, type BedrockType, type SeisStation } from '@/types/station';
import {
  COMMON_CHANNELS,
  INSTALL_STATES,
  LEGACY_CHANNEL,
  createEmptyInstallDraft,
  type Install,
  type InstallState,
} from '@/types/install';
import { qualifyForInstall, qualifyStatForInstalls } from '@/utils/qualify';
import { initDatabase } from '@/utils/db';

interface StationFormValues {
  code: string;
  lat: number;
  lng: number;
  elevM: number;
  bedrock: BedrockType;
  siteNote: string;
}

interface InstallFormValues {
  channel: string;
  serialNo: string;
  installDate: dayjs.Dayjs | null;
  state: InstallState;
  remark: string;
}

/** 台站行统计：安装位、当前设备标定与合格率 */
interface StationRow {
  station: SeisStation;
  installs: Install[];
  stat: ReturnType<typeof qualifyStatForInstalls>;
  pendingClaims: number;
}

export default function StationInstruments() {
  const { id: arrayId = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const arrays = useAppSelector(selectArrays);
  const ready = useAppSelector(selectArrayReady);
  const array = useAppSelector((state) => selectArrayById(state, arrayId));
  const stations = useAppSelector((state) => selectStationsOfArray(state, arrayId));
  const stationFilter = useAppSelector(selectStationFilter);
  const allInstalls = useAppSelector(selectInstalls);
  const devices = useAppSelector(selectDevices);
  const calibrations = useAppSelector(selectCalibrations);
  const claims = useAppSelector(selectClaims);

  const [stationModalOpen, setStationModalOpen] = useState(false);
  const [editingStationId, setEditingStationId] = useState<string | null>(null);
  const [installModalOpen, setInstallModalOpen] = useState(false);
  const [editingInstallId, setEditingInstallId] = useState<string | null>(null);
  const [activeStationId, setActiveStationId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stationForm] = Form.useForm<StationFormValues>();
  const [installForm] = Form.useForm<InstallFormValues>();

  useEffect(() => {
    if (arrays.length === 0) void initDatabase();
  }, [arrays.length]);

  const activeStation = useMemo(
    () => stations.find((station) => station.id === activeStationId) ?? null,
    [activeStationId, stations]
  );

  const activeInstalls = useAppSelector((state) =>
    selectInstallsOfStation(state, activeStationId)
  );

  const deviceBySerial = useMemo(
    () => new Map(devices.map((device) => [device.serialNo, device])),
    [devices]
  );
  const pendingClaimKeys = useMemo(
    () =>
      new Set(
        claims
          .filter((claim) => claim.state === '待认领')
          .map((claim) => `${claim.installId ?? ''}:${claim.serialNo}`)
      ),
    [claims]
  );

  /** 台站行：按安装位当前设备重算合格率 */
  const rows = useMemo<StationRow[]>(
    () =>
      stations
        .filter((station) => {
          const keyword = stationFilter.keyword.trim();
          if (keyword.length > 0 && !`${station.code}${station.bedrock}${station.siteNote}`.includes(keyword)) {
            return false;
          }
          if (stationFilter.bedrocks.length > 0 && !stationFilter.bedrocks.includes(station.bedrock)) return false;
          if (stationFilter.minElevM !== null && station.elevM < stationFilter.minElevM) return false;
          const count = allInstalls.filter((install) => install.stationId === station.id).length;
          if (stationFilter.onlyEmpty && count > 0) return false;
          return true;
        })
        .map((station) => {
          const stationInstalls = allInstalls.filter((install) => install.stationId === station.id);
          return {
            station,
            installs: stationInstalls,
            stat: qualifyStatForInstalls(stationInstalls, calibrations),
            pendingClaims: claims.filter(
              (claim) => claim.stationId === station.id && claim.state === '待认领'
            ).length,
          };
        }),
    [allInstalls, calibrations, claims, stationFilter, stations]
  );

  const totals = useMemo(
    () => ({
      stations: rows.length,
      installs: rows.reduce((sum, row) => sum + row.installs.length, 0),
      calibrations: rows.reduce((sum, row) => sum + row.stat.calibrationCount, 0),
      qualified: rows.reduce((sum, row) => sum + row.stat.qualified, 0),
      withCalibration: rows.reduce((sum, row) => sum + row.stat.withCalibration, 0),
      unqualified: rows.reduce((sum, row) => sum + row.stat.unqualifiedCalibrations, 0),
      overdue: rows.reduce((sum, row) => sum + row.stat.overdue, 0),
      pendingClaims: rows.reduce((sum, row) => sum + row.pendingClaims, 0),
    }),
    [rows]
  );
  const overallRate = totals.withCalibration === 0 ? 0 : Math.round((totals.qualified / totals.withCalibration) * 1000) / 10;

  const stationFilterModel: FilterModel = {
    keyword: stationFilter.keyword,
    bedrocks: stationFilter.bedrocks,
    minElevM: stationFilter.minElevM,
  };

  const openStationCreate = () => {
    setEditingStationId(null);
    stationForm.setFieldsValue({
      code: `ST${String(stations.length + 1).padStart(2, '0')}`,
      lat: 30.8,
      lng: 103.5,
      elevM: 1000,
      bedrock: '花岗岩',
      siteNote: '',
    });
    setStationModalOpen(true);
  };

  const openStationEdit = (station: SeisStation) => {
    setEditingStationId(station.id);
    stationForm.setFieldsValue({
      code: station.code,
      lat: station.lat,
      lng: station.lng,
      elevM: station.elevM,
      bedrock: station.bedrock,
      siteNote: station.siteNote,
    });
    setStationModalOpen(true);
  };

  const submitStation = async () => {
    const values = await stationForm.validateFields();
    const latLngErrors = validateLatLng(Number(values.lat), Number(values.lng));
    if (latLngErrors.length > 0) {
      message.warning(`经纬度校验未通过：${latLngErrors.join('；')}`);
      return;
    }
    const duplicated = stations.some(
      (station) => station.code === values.code.trim() && station.id !== editingStationId
    );
    if (duplicated) {
      message.warning(`台站码「${values.code.trim()}」在本台阵已存在`);
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        arrayId,
        code: values.code.trim(),
        lat: Number(values.lat),
        lng: Number(values.lng),
        elevM: Number(values.elevM),
        bedrock: values.bedrock,
        siteNote: values.siteNote?.trim() ?? '',
      };
      if (editingStationId) {
        await dispatch(updateStation({ id: editingStationId, patch: payload })).unwrap();
        message.success('台站已更新');
      } else {
        await dispatch(createStation(payload)).unwrap();
        message.success(`台站 ${payload.code} 已新增`);
      }
      setStationModalOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const openInstallCreate = (station: SeisStation) => {
    setActiveStationId(station.id);
    setEditingInstallId(null);
    dispatch(resetDraft());
    const draft = { ...createEmptyInstallDraft(station.id), stationId: station.id };
    dispatch(patchDraft(draft));
    installForm.setFieldsValue({
      channel: COMMON_CHANNELS[0],
      serialNo: `${station.code}-${Date.now().toString(36).toUpperCase().slice(-4)}`,
      installDate: dayjs(),
      state: '在用',
      remark: '',
    });
    setInstallModalOpen(true);
  };

  const openInstallEdit = (station: SeisStation, install: Install) => {
    setActiveStationId(station.id);
    setEditingInstallId(install.id);
    installForm.setFieldsValue({
      channel: install.channel,
      serialNo: install.serialNo,
      installDate: dayjs(install.installDate),
      state: install.state,
      remark: install.remark,
    });
    setInstallModalOpen(true);
  };

  const submitInstall = async () => {
    if (!activeStationId) {
      message.warning('请先选择一个台站');
      return;
    }
    const values = await installForm.validateFields();
    setSubmitting(true);
    try {
      const payload = {
        stationId: activeStationId,
        channel: values.channel.trim().toUpperCase(),
        serialNo: values.serialNo.trim(),
        installDate: values.installDate ? values.installDate.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
        state: values.state,
        remark: values.remark?.trim() ?? '',
      };
      if (editingInstallId) {
        await dispatch(updateInstall({ id: editingInstallId, patch: payload })).unwrap();
        message.success('安装位已更新（换机只改序列号，安装位与历史标定归属不变）');
      } else {
        await dispatch(createInstall(payload)).unwrap();
        const known = devices.some((device) => device.serialNo === payload.serialNo);
        message.success(
          known
            ? '安装位已登记，序列号与计量站档案一致'
            : '安装位已登记，但该序列号计量站尚无档案，已挂账待认领'
        );
      }
      setInstallModalOpen(false);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '安装位保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleBulkPending = async () => {
    const scopedIds = Array.from(
      new Set(rows.flatMap((row) => row.installs.map((install) => install.id)))
    );
    if (scopedIds.length === 0) {
      message.warning('当前筛选范围内没有可批量操作的安装位');
      return;
    }
    await dispatch(bulkSetInstallState({ ids: scopedIds, state: '待标定' })).unwrap();
    message.success(`已将 ${scopedIds.length} 个安装位状态置为待标定`);
  };

  if (!ready) {
    return <Skeleton active paragraph={{ rows: 6 }} />;
  }

  if (!array) {
    return (
      <RouteMissingPanel
        entityLabel="台阵"
        missingId={arrayId}
        fallbackPath={ROUTES.arrays}
        fallbackText="返回台阵台账"
        candidates={arrays.slice(0, 3).map((row) => ({
          id: row.id,
          label: `${row.name} 的台站安装位`,
          path: ROUTES.stations(row.id),
        }))}
      />
    );
  }

  const renderSerialCell = (install: Install) => {
    const isPending = pendingClaimKeys.has(`${install.id}:${install.serialNo}`);
    const device = deviceBySerial.get(install.serialNo);
    if (isPending) {
      return (
        <Tooltip title="该序列号在计量站物理仪器档案中不存在，已挂账待认领（认过才算数）">
          <Tag color="orange" icon={<WarningFilled />}>
            <span className="gb-mono">{install.serialNo}</span>
          </Tag>
        </Tooltip>
      );
    }
    return (
      <div>
        <span className="gb-mono">{install.serialNo}</span>
        {device ? (
          <div className="gb-hint">
            {device.model} · 合格到期 {device.qualifyDueDate ?? '未标定'}
          </div>
        ) : (
          <div className="gb-hint">档案缺失</div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Breadcrumb
            items={[
              { title: <a onClick={() => navigate(ROUTES.arrays)}>台阵台账</a> },
              { title: array.name },
              { title: '台站安装位' },
            ]}
          />
          <Typography.Title level={4} style={{ margin: '8px 0 4px', color: '#1e3a5f' }}>
            {array.name} · 台站安装位维护（运维班组）
          </Typography.Title>
          <p className="gb-hint">
            按台站记安装位、通道、安装日期和当前序列号；换机后安装位保留、序列号落到新的一台，
            旧设备历次标定仍挂原序列号。序列号对不上先挂账，计量站认过才算数。
          </p>
        </div>
        <Space wrap>
          <Button
            icon={<SyncOutlined />}
            onClick={() =>
              void dispatch(recomputeAperture(array.id))
                .unwrap()
                .then((result) => message.success(`已按经纬度重算孔径：${result.apertureKm} km`))
            }
          >
            重算孔径
          </Button>
          <Button onClick={() => void handleBulkPending()}>批量置为待标定</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openStationCreate}>
            新增台站
          </Button>
        </Space>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="台站数" value={totals.stations} suffix="个" tone="info" />
        <StatBadge label="安装位" value={totals.installs} suffix="个" tone="primary" />
        <StatBadge
          label="当前设备标定"
          value={totals.calibrations}
          suffix="次"
          tone="default"
        />
        <StatBadge
          label="安装位合格率"
          value={overallRate}
          percent={overallRate}
          tone={overallRate >= 80 ? 'success' : 'warning'}
          tip="合格安装位 ÷ 当前设备有标定的安装位；换机后按当前那台重算"
        />
        <StatBadge
          label="不合格标定"
          value={totals.unqualified}
          suffix="次"
          tone={totals.unqualified > 0 ? 'danger' : 'success'}
        />
        <StatBadge
          label="超期未标定"
          value={totals.overdue}
          suffix="个"
          tone={totals.overdue > 0 ? 'warning' : 'success'}
        />
        <StatBadge
          label="待认领序列号"
          value={totals.pendingClaims}
          suffix="个"
          tone={totals.pendingClaims > 0 ? 'warning' : 'success'}
        />
      </div>

      <FilterBar
        modelValue={stationFilterModel}
        selects={[
          {
            key: 'bedrocks',
            label: '基岩类型',
            options: BEDROCK_TYPES.map((bedrock) => ({ label: bedrock, value: bedrock })),
          },
        ]}
        numberRanges={[{ key: 'minElevM', label: '高程不低于', placeholder: '不限', suffix: 'm' }]}
        hasSwitch
        switchLabel="仅看未装仪器的台站"
        switchValue={stationFilter.onlyEmpty}
        keywordPlaceholder="搜索台站码 / 基岩 / 场地备注"
        onChange={(next, switchValue) => {
          dispatch(
            patchStationFilter({
              keyword: next.keyword,
              bedrocks: ((next.bedrocks as string[]) ?? []) as BedrockType[],
              minElevM: (next.minElevM as number | null) ?? null,
              onlyEmpty: switchValue,
            })
          );
        }}
        onReset={() => dispatch(resetStationFilter())}
      />

      {rows.length === 0 ? (
        <EmptyPanel
          title={stations.length === 0 ? '该台阵还没有台站' : '没有符合条件的台站'}
          description="新增台站并录入经纬度、高程与基岩类型后，即可在安装位上登记当前序列号。"
          actionText="新增台站"
          secondaryText="重置筛选"
          onAction={openStationCreate}
          onSecondary={() => dispatch(resetStationFilter())}
        />
      ) : (
        <Table
          rowKey={(row) => row.station.id}
          className="gb-table-compact"
          dataSource={rows}
          pagination={false}
          columns={[
            {
              title: '台站码',
              width: 110,
              render: (_: unknown, row: StationRow) => <span className="gb-mono">{row.station.code}</span>,
            },
            {
              title: '经纬度',
              width: 200,
              render: (_: unknown, row: StationRow) => (
                <div>
                  <div className="gb-mono">
                    {row.station.lat.toFixed(4)}, {row.station.lng.toFixed(4)}
                  </div>
                </div>
              ),
            },
            {
              title: '高程 (m)',
              width: 100,
              align: 'right',
              render: (_: unknown, row: StationRow) => <span className="gb-mono">{row.station.elevM}</span>,
            },
            {
              title: '基岩',
              width: 100,
              render: (_: unknown, row: StationRow) => <Tag>{row.station.bedrock}</Tag>,
            },
            {
              title: '安装位数',
              width: 100,
              align: 'center',
              render: (_: unknown, row: StationRow) => (
                <Button type="link" size="small" onClick={() => setActiveStationId(row.station.id)}>
                  {row.installs.length} 个
                </Button>
              ),
            },
            {
              title: '当前设备合格率',
              width: 150,
              align: 'right',
              render: (_: unknown, row: StationRow) => (
                <span className="gb-mono">
                  {row.stat.qualified}/{row.stat.withCalibration}（{row.stat.qualifyRate}%）
                </span>
              ),
            },
            {
              title: '标定 / 不合格',
              width: 130,
              align: 'right',
              render: (_: unknown, row: StationRow) => (
                <span className="gb-mono">
                  {row.stat.calibrationCount} /{' '}
                  <span className={row.stat.unqualifiedCalibrations > 0 ? 'gb-danger' : ''}>
                    {row.stat.unqualifiedCalibrations}
                  </span>
                </span>
              ),
            },
            {
              title: '标定提醒',
              width: 140,
              render: (_: unknown, row: StationRow) =>
                row.stat.overdue > 0 ? (
                  <Tag color="red">超期 {row.stat.overdue} 个</Tag>
                ) : (
                  <Tag color="green">按期</Tag>
                ),
            },
            {
              title: '序列号对账',
              width: 130,
              render: (_: unknown, row: StationRow) =>
                row.pendingClaims > 0 ? (
                  <Tag color="orange" icon={<WarningFilled />}>
                    待认领 {row.pendingClaims}
                  </Tag>
                ) : (
                  <Tag color="green">已对齐</Tag>
                ),
            },
            { title: '场地备注', dataIndex: ['station', 'siteNote'], ellipsis: true },
            {
              title: '操作',
              width: 250,
              render: (_: unknown, row: StationRow) => (
                <Space size={6}>
                  <Button size="small" type="primary" onClick={() => openInstallCreate(row.station)}>
                    登记安装位
                  </Button>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openStationEdit(row.station)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除台站"
                    description="将同时删除其安装位与更换记录；物理仪器档案和标定保留，确认删除？"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() =>
                      void dispatch(removeStation(row.station.id))
                        .unwrap()
                        .then(() => message.success('台站及其安装位已删除（物理仪器保留）'))
                    }
                  >
                    <Button size="small" danger icon={<DeleteOutlined />}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      )}

      {activeStation ? (
        <Card
          className="gb-panel"
          size="small"
          title={`${activeStation.code} · 安装位清单（${activeInstalls.length} 个）`}
          extra={
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => openInstallCreate(activeStation)}>
              登记安装位
            </Button>
          }
        >
          {activeInstalls.length === 0 ? (
            <EmptyPanel
              title="该台站还没有安装位"
              description="按通道登记安装位与当前序列号；换机时只改序列号，安装位保留。"
              actionText="登记安装位"
              onAction={() => openInstallCreate(activeStation)}
              compact
            />
          ) : (
            <Table
              rowKey="id"
              size="small"
              className="gb-table-compact"
              dataSource={activeInstalls}
              pagination={false}
              columns={[
                {
                  title: '通道',
                  dataIndex: 'channel',
                  width: 110,
                  render: (value: string) => (
                    <Tag color="blue">{value === LEGACY_CHANNEL ? '通道待补' : value}</Tag>
                  ),
                },
                {
                  title: '当前序列号（计量档案）',
                  width: 280,
                  render: (_: unknown, install: Install) => renderSerialCell(install),
                },
                { title: '安装日期', dataIndex: 'installDate', width: 120, className: 'gb-mono' },
                {
                  title: '状态',
                  dataIndex: 'state',
                  width: 100,
                  render: (value: string) => (
                    <Tag color={value === '在用' ? 'green' : value === '待标定' ? 'orange' : 'default'}>{value}</Tag>
                  ),
                },
                {
                  title: '当前设备标定',
                  width: 220,
                  render: (_: unknown, install: Install) => {
                    const q = qualifyForInstall(install, calibrations);
                    if (!q.latest) return <span className="gb-hint">该序列号尚无标定</span>;
                    return (
                      <div>
                        <QualifyTag verdict={q.latest.responseVerdict} size="small" />
                        <div className="gb-hint gb-mono">{q.count} 次 · {q.latest.date}</div>
                      </div>
                    );
                  },
                },
                {
                  title: '合格到期',
                  width: 140,
                  render: (_: unknown, install: Install) => {
                    const q = qualifyForInstall(install, calibrations);
                    return (
                      <span className={q.overdue ? 'gb-danger gb-mono' : 'gb-mono'}>
                        {q.dueDate ?? '—'}
                        {q.overdue ? `（超期 ${Math.abs(q.dueInDays)} 天）` : ''}
                      </span>
                    );
                  },
                },
                {
                  title: '操作',
                  width: 200,
                  render: (_: unknown, install: Install) => (
                    <Space size={6}>
                      <Button size="small" onClick={() => navigate(ROUTES.replacements)}>
                        更换
                      </Button>
                      <Button size="small" icon={<EditOutlined />} onClick={() => openInstallEdit(activeStation, install)}>
                        编辑
                      </Button>
                      <Popconfirm
                        title="删除安装位"
                        description="仅删除该安装位与更换记录；物理仪器及其历次标定保留在计量侧，确认？"
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() =>
                          void dispatch(removeInstall(install.id))
                            .unwrap()
                            .then(() => message.success('安装位已删除（物理仪器与标定保留）'))
                        }
                      >
                        <Button size="small" danger>
                          删除
                        </Button>
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]}
            />
          )}
        </Card>
      ) : (
        <Card className="gb-panel" size="small">
          <EmptyPanel
            title="请选择台站查看安装位"
            description="在上表点击任一「安装位数」或「登记安装位」按钮，即可维护该台站的通道与当前序列号。"
            compact
          />
        </Card>
      )}

      <p className="gb-hint">
        物理仪器的型号、历次标定与合格到期日由计量站在
        <Button type="link" size="small" onClick={() => navigate(ROUTES.devices)}>
          物理仪器档案
        </Button>
        维护；序列号对不上的记录到
        <Button type="link" size="small" onClick={() => navigate(ROUTES.claims)}>
          序列号对账
        </Button>
        认领。
      </p>

      <Modal
        open={stationModalOpen}
        title={editingStationId ? '编辑台站' : '新增台站'}
        onCancel={() => setStationModalOpen(false)}
        onOk={() => void submitStation()}
        confirmLoading={submitting}
        okText={editingStationId ? '保存修改' : '新增台站'}
        destroyOnClose
      >
        <Form form={stationForm} layout="vertical" preserve={false}>
          <Form.Item name="code" label="台站码" rules={[{ required: true, message: '请填写台站码' }]}>
            <Input placeholder="如：LTX01" maxLength={20} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="lat" label="纬度" rules={[{ required: true, message: '请填写纬度' }]}>
                <InputNumber min={-90} max={90} step={0.0001} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="lng" label="经度" rules={[{ required: true, message: '请填写经度' }]}>
                <InputNumber min={-180} max={180} step={0.0001} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="elevM" label="高程 (m)" rules={[{ required: true }]}>
                <InputNumber min={-500} max={9000} step={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="bedrock" label="基岩类型" rules={[{ required: true }]}>
                <Select options={BEDROCK_TYPES.map((bedrock) => ({ label: bedrock, value: bedrock }))} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="siteNote" label="场地备注">
            <Input.TextArea rows={2} maxLength={80} placeholder="如：基岩出露，噪声本底低" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={installModalOpen}
        title={`${editingInstallId ? '编辑' : '登记'}安装位 · ${activeStation?.code ?? ''}`}
        onCancel={() => setInstallModalOpen(false)}
        onOk={() => void submitInstall()}
        confirmLoading={submitting}
        okText={editingInstallId ? '保存修改' : '登记安装位'}
        destroyOnClose
      >
        <Form form={installForm} layout="vertical" preserve={false}>
          <Form.Item name="channel" label="观测通道" rules={[{ required: true, message: '请填写通道' }]}>
            <Select
              showSearch
              mode="tags"
              maxCount={1}
              options={COMMON_CHANNELS.map((channel) => ({ label: channel, value: channel }))}
              placeholder="选择或输入通道，如 BHZ / SLZ"
            />
          </Form.Item>
          <Form.Item
            name="serialNo"
            label="当前序列号"
            rules={[{ required: true, message: '请填写当前安装仪器的序列号' }]}
            extra="序列号是连接计量档案的键；计量站无此档案时会自动挂账待认领，不影响先登记安装位。"
          >
            <Input placeholder="如：CMG-3E-20210418-01" maxLength={60} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="installDate" label="安装日期（换机日）" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="state" label="运行状态" rules={[{ required: true }]}>
                <Select options={INSTALL_STATES.map((state) => ({ label: state, value: state }))} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={80} placeholder="如：井下安装，深度 42 m" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
