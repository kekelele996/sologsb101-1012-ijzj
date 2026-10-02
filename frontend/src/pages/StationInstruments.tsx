/**
 * 模块 2：/stations/:id/instruments 台站安装位与仪器登记
 * 运维班组按台站维护安装位（通道、安装日期、当前序列号），计量站按序列号记物理仪器。
 * 换机后安装位留着、序列号落到新的一台，历次标定跟原序列号走；
 * 台站卡片合格率按安装位当前那台重算。序列号对不上的先挂台账待认，认过才算数。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  App as AntdApp,
  Breadcrumb,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  SwapOutlined,
  SyncOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
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
  acknowledgeInstallation,
  bulkSetInstrumentState,
  createInstrument,
  createMissingInstrument,
  patchDraft,
  reconcileInstallations,
  removeInstallation,
  resetDraft,
  selectCurrentDeviceOfInstallation,
  selectDevicesOfStation,
  selectInstallations,
  selectInstallationsOfStation,
  selectInstruments,
  selectPendingSyncCount,
  swapInstrument,
  updateInstrument,
} from '@/stores/instrumentSlice';
import { selectCalibrations, selectReplaces } from '@/stores/calibrationSlice';
import { BEDROCK_TYPES, validateLatLng, type BedrockType, type SeisStation } from '@/types/station';
import {
  COMMON_MODELS,
  INSTRUMENT_STATES,
  INSTRUMENT_TYPES,
  createEmptyInstrumentDraft,
  daysUntilDue,
  type Installation,
  type Instrument,
  type InstrumentState,
  type InstrumentType,
} from '@/types/instrument';
import { formatLatLng, round } from '@/utils/geo';
import { currentDevicesOfStation, stationCalibrationStats } from '@/utils/ledger';
import { initDatabase } from '@/utils/db';

interface StationFormValues {
  code: string;
  lat: number;
  lng: number;
  elevM: number;
  bedrock: BedrockType;
  siteNote: string;
}

interface InstrumentFormValues {
  channel: string;
  type: InstrumentType;
  model: string;
  serialNo: string;
  installDate: dayjs.Dayjs | null;
  state: InstrumentState;
  remark: string;
}

interface SwapFormValues {
  newSerialNo: string;
  date: dayjs.Dayjs | null;
  reason: string;
  operator: string;
}

interface MissingFormValues {
  type: InstrumentType;
  model: string;
}

/** 台站行统计：安装位数、当前在位数、标定数、不合格数与超期台数 */
interface StationRow {
  station: SeisStation;
  installationCount: number;
  deviceCount: number;
  calibrationCount: number;
  unqualified: number;
  overdue: number;
  worstVerdict: string;
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
  const allInstruments = useAppSelector(selectInstruments);
  const allInstallations = useAppSelector(selectInstallations);
  const calibrations = useAppSelector(selectCalibrations);
  const replaces = useAppSelector(selectReplaces);
  const pendingSync = useAppSelector(selectPendingSyncCount);

  const [stationModalOpen, setStationModalOpen] = useState(false);
  const [editingStationId, setEditingStationId] = useState<string | null>(null);
  const [instrumentModalOpen, setInstrumentModalOpen] = useState(false);
  const [editingInstrumentId, setEditingInstrumentId] = useState<string | null>(null);
  const [swapModalOpen, setSwapModalOpen] = useState(false);
  const [swapInstallation, setSwapInstallation] = useState<Installation | null>(null);
  const [missingModalOpen, setMissingModalOpen] = useState(false);
  const [missingInstallation, setMissingInstallation] = useState<Installation | null>(null);
  const [activeStationId, setActiveStationId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stationForm] = Form.useForm<StationFormValues>();
  const [instrumentForm] = Form.useForm<InstrumentFormValues>();
  const [swapForm] = Form.useForm<SwapFormValues>();
  const [missingForm] = Form.useForm<MissingFormValues>();

  useEffect(() => {
    if (arrays.length === 0) void initDatabase();
  }, [arrays.length]);

  const activeStation = useMemo(
    () => stations.find((station) => station.id === activeStationId) ?? null,
    [activeStationId, stations]
  );

  const activeInstallations = useAppSelector((state) =>
    selectInstallationsOfStation(state, activeStationId)
  );

  /** 台站行：附带安装位、当前在位数设备、标定与超期统计 */
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
          const count = allInstallations.filter((inst) => inst.stationId === station.id).length;
          if (stationFilter.onlyEmpty && count > 0) return false;
          return true;
        })
        .map((station) => {
          const stats = stationCalibrationStats(station.id, allInstallations, allInstruments, calibrations);
          const devices = currentDevicesOfStation(station.id, allInstallations, allInstruments);
          return {
            station,
            installationCount: allInstallations.filter((inst) => inst.stationId === station.id).length,
            deviceCount: devices.length,
            calibrationCount: stats.total,
            unqualified: stats.unqualified,
            overdue: stats.overdue,
            worstVerdict: stats.unqualified > 0 ? '不合格' : stats.total > 0 ? '合格' : '待判定',
          };
        }),
    [allInstruments, allInstallations, calibrations, stationFilter, stations]
  );

  const totals = useMemo(
    () => ({
      stations: rows.length,
      installations: rows.reduce((sum, row) => sum + row.installationCount, 0),
      devices: rows.reduce((sum, row) => sum + row.deviceCount, 0),
      calibrations: rows.reduce((sum, row) => sum + row.calibrationCount, 0),
      unqualified: rows.reduce((sum, row) => sum + row.unqualified, 0),
      overdue: rows.reduce((sum, row) => sum + row.overdue, 0),
    }),
    [rows]
  );

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
    const errors = validateLatLng(Number(values.lat), Number(values.lng));
    if (errors.length > 0) {
      message.warning(`经纬度校验未通过：${errors.join('；')}`);
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
        message.success(`台站 ${payload.code} 已新增（${formatLatLng(payload.lat, payload.lng)}）`);
      }
      setStationModalOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const openInstrumentCreate = (station: SeisStation) => {
    setActiveStationId(station.id);
    setEditingInstrumentId(null);
    dispatch(resetDraft());
    const draft = { ...createEmptyInstrumentDraft(), stationId: station.id };
    dispatch(patchDraft(draft));
    instrumentForm.setFieldsValue({
      channel: draft.channel,
      type: draft.type,
      model: COMMON_MODELS[draft.type][0] ?? '',
      serialNo: `${station.code}-${Date.now().toString(36).toUpperCase().slice(-4)}`,
      installDate: dayjs(),
      state: '在用',
      remark: '',
    });
    setInstrumentModalOpen(true);
  };

  const openInstrumentEdit = (station: SeisStation, instrument: Instrument) => {
    setActiveStationId(station.id);
    setEditingInstrumentId(instrument.id);
    instrumentForm.setFieldsValue({
      channel: '',
      type: instrument.type,
      model: instrument.model,
      serialNo: instrument.serialNo,
      installDate: dayjs(),
      state: instrument.state,
      remark: instrument.remark,
    });
    setInstrumentModalOpen(true);
  };

  const submitInstrument = async () => {
    if (!activeStationId) {
      message.warning('请先选择一个台站');
      return;
    }
    const values = await instrumentForm.validateFields();
    setSubmitting(true);
    try {
      const payload = {
        stationId: activeStationId,
        channel: values.channel?.trim() || values.type,
        type: values.type,
        model: values.model.trim(),
        serialNo: values.serialNo.trim(),
        installDate: values.installDate ? values.installDate.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
        state: values.state,
        remark: values.remark?.trim() ?? '',
      };
      if (editingInstrumentId) {
        await dispatch(
          updateInstrument({
            id: editingInstrumentId,
            patch: {
              type: payload.type,
              model: payload.model,
              serialNo: payload.serialNo,
              state: payload.state,
              remark: payload.remark,
            },
          })
        ).unwrap();
        message.success('仪器信息已更新');
      } else {
        await dispatch(createInstrument(payload)).unwrap();
        dispatch(patchDraft(payload));
        message.success(`仪器已登记：安装位 ${payload.channel}，序列号 ${payload.serialNo}`);
      }
      setInstrumentModalOpen(false);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '仪器保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  const openSwap = (installation: Installation) => {
    setSwapInstallation(installation);
    swapForm.setFieldsValue({
      newSerialNo: '',
      date: dayjs(),
      reason: '',
      operator: '',
    });
    setSwapModalOpen(true);
  };

  const submitSwap = async () => {
    if (!swapInstallation) return;
    const values = await swapForm.validateFields();
    setSubmitting(true);
    try {
      await dispatch(
        swapInstrument({
          installationId: swapInstallation.id,
          newSerialNo: values.newSerialNo.trim(),
          reason: values.reason?.trim() ?? '',
          date: values.date ? values.date.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
          operator: values.operator?.trim() ?? '',
        })
      ).unwrap();
      message.success('换机完成：安装位保留，新序列号已落到新设备');
      setSwapModalOpen(false);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '换机失败');
    } finally {
      setSubmitting(false);
    }
  };

  const openMissing = (installation: Installation) => {
    setMissingInstallation(installation);
    const device = allInstruments.find((ins) => ins.serialNo === installation.serialNo);
    missingForm.setFieldsValue({
      type: device?.type ?? '宽频带',
      model: device?.model ?? '',
    });
    setMissingModalOpen(true);
  };

  const submitMissing = async () => {
    if (!missingInstallation) return;
    const values = await missingForm.validateFields();
    setSubmitting(true);
    try {
      await dispatch(
        createMissingInstrument({
          installationId: missingInstallation.id,
          type: values.type,
          model: values.model.trim(),
        })
      ).unwrap();
      message.success('已补建物理仪器，安装位已认账');
      setMissingModalOpen(false);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '补建失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleReconcile = async () => {
    const result = await dispatch(reconcileInstallations()).unwrap();
    message.success(`对账完成：${result.promoted} 条待认安装位已认账（已认不退回）`);
  };

  const handleBulkPending = async () => {
    const targetIds = rows.flatMap((row) =>
      currentDevicesOfStation(row.station.id, allInstallations, allInstruments).map((ins) => ins.id)
    );
    if (targetIds.length === 0) {
      message.warning('当前筛选范围内没有可批量操作的仪器');
      return;
    }
    await dispatch(bulkSetInstrumentState({ ids: targetIds, state: '待标定' })).unwrap();
    message.success(`已将 ${targetIds.length} 台仪器状态置为待标定`);
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
          label: `${row.name} 的台站仪器`,
          path: ROUTES.stations(row.id),
        }))}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Breadcrumb
            items={[
              { title: <a onClick={() => navigate(ROUTES.arrays)}>台阵台账</a> },
              { title: array.name },
              { title: '台站仪器' },
            ]}
          />
          <Typography.Title level={4} style={{ margin: '8px 0 4px', color: '#1e3a5f' }}>
            {array.name} · 台站仪器登记
          </Typography.Title>
          <p className="gb-hint">
            运维班组按台站维护安装位（通道、安装日期、当前序列号），计量站按序列号记物理仪器。
            换机后安装位留着、序列号落到新的一台，历次标定跟原序列号走；合格率按安装位当前那台重算。
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
          <Button
            icon={<CheckCircleOutlined />}
            onClick={() => void handleReconcile()}
          >
            对账认账
            {pendingSync > 0 ? <Tag color="orange" style={{ marginInlineStart: 6 }}>{pendingSync}</Tag> : null}
          </Button>
          <Button onClick={() => void handleBulkPending()}>批量置为待标定</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openStationCreate}>
            新增台站
          </Button>
        </Space>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="台站数" value={totals.stations} suffix="个" tone="info" />
        <StatBadge label="安装位" value={totals.installations} suffix="个" tone="primary" />
        <StatBadge label="在位数仪器" value={totals.devices} suffix="台" tone="primary" />
        <StatBadge label="累计标定" value={totals.calibrations} suffix="次" tone="default" />
        <StatBadge
          label="不合格标定"
          value={totals.unqualified}
          suffix="次"
          tone={totals.unqualified > 0 ? 'danger' : 'success'}
        />
        <StatBadge
          label="超期未标定"
          value={totals.overdue}
          suffix="台"
          tone={totals.overdue > 0 ? 'warning' : 'success'}
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
        switchLabel="仅看未安装仪器的台站"
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
          description="新增台站并录入经纬度、高程与基岩类型后，即可登记仪器并录入标定结果。"
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
                  <div className="gb-hint gb-mono">{formatLatLng(row.station.lat, row.station.lng)}</div>
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
              width: 110,
              render: (_: unknown, row: StationRow) => <Tag>{row.station.bedrock}</Tag>,
            },
            {
              title: '安装位 / 在位数',
              width: 120,
              align: 'center',
              render: (_: unknown, row: StationRow) => (
                <Button type="link" size="small" onClick={() => setActiveStationId(row.station.id)}>
                  {row.installationCount} / {row.deviceCount}
                </Button>
              ),
            },
            {
              title: '标定 / 不合格',
              width: 140,
              align: 'right',
              render: (_: unknown, row: StationRow) => (
                <span className="gb-mono">
                  {row.calibrationCount} /{' '}
                  <span className={row.unqualified > 0 ? 'gb-danger' : ''}>{row.unqualified}</span>
                </span>
              ),
            },
            {
              title: '标定提醒',
              width: 130,
              render: (_: unknown, row: StationRow) =>
                row.overdue > 0 ? <Tag color="red">超期 {row.overdue} 台</Tag> : <Tag color="green">按期</Tag>,
            },
            {
              title: '综合结论',
              width: 120,
              render: (_: unknown, row: StationRow) => <QualifyTag verdict={row.worstVerdict as never} size="small" />,
            },
            { title: '场地备注', dataIndex: ['station', 'siteNote'], ellipsis: true },
            {
              title: '操作',
              width: 250,
              render: (_: unknown, row: StationRow) => (
                <Space size={6}>
                  <Button size="small" type="primary" onClick={() => openInstrumentCreate(row.station)}>
                    登记仪器
                  </Button>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openStationEdit(row.station)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除台站"
                    description={`将同时删除其安装位、仪器、标定与更换记录，确认删除「${row.station.code}」？`}
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() =>
                      void dispatch(removeStation(row.station.id))
                        .unwrap()
                        .then(() => message.success('台站及其下级数据已删除'))
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
          title={`${activeStation.code} · 安装位清单（${activeInstallations.length} 个）`}
          extra={
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => openInstrumentCreate(activeStation)}>
              登记仪器
            </Button>
          }
        >
          {activeInstallations.length === 0 ? (
            <EmptyPanel
              title="该台站还没有安装位"
              description="登记宽频带 / 短周期 / 强震仪器，序列号需全局唯一；登记后自动生成安装位。"
              actionText="登记仪器"
              onAction={() => openInstrumentCreate(activeStation)}
              compact
            />
          ) : (
            <Table
              rowKey="id"
              size="small"
              className="gb-table-compact"
              dataSource={activeInstallations}
              pagination={false}
              columns={[
                {
                  title: '通道',
                  dataIndex: 'channel',
                  width: 110,
                  render: (value: string) => <Tag>{value}</Tag>,
                },
                {
                  title: '当前序列号',
                  dataIndex: 'serialNo',
                  width: 220,
                  render: (value: string, inst: Installation) => (
                    <div>
                      <span className="gb-mono">{value}</span>
                      {inst.syncStatus === '待认' ? (
                        <Tag color="orange" style={{ marginInlineStart: 6 }}>待认</Tag>
                      ) : (
                        <Tag color="green" style={{ marginInlineStart: 6 }}>已认</Tag>
                      )}
                    </div>
                  ),
                },
                {
                  title: '型号',
                  width: 160,
                  render: (_: unknown, inst: Installation) => {
                    const device = allInstruments.find((ins) => ins.serialNo === inst.serialNo);
                    return device ? device.model : <span className="gb-hint">计量站未建档</span>;
                  },
                },
                { title: '安装日期', dataIndex: 'installDate', width: 120, className: 'gb-mono' },
                {
                  title: '标定次数',
                  width: 90,
                  align: 'right',
                  render: (_: unknown, inst: Installation) => {
                    const device = allInstruments.find((ins) => ins.serialNo === inst.serialNo);
                    const count = device
                      ? calibrations.filter((row) => row.instrumentId === device.id).length
                      : 0;
                    return <span className="gb-mono">{count}</span>;
                  },
                },
                {
                  title: '最近结论',
                  width: 170,
                  render: (_: unknown, inst: Installation) => {
                    const device = allInstruments.find((ins) => ins.serialNo === inst.serialNo);
                    if (!device) return <span className="gb-hint">待认</span>;
                    const own = calibrations
                      .filter((row) => row.instrumentId === device.id)
                      .sort((a, b) => b.date.localeCompare(a.date));
                    const latest = own[0];
                    if (!latest) return <span className="gb-hint">尚未标定</span>;
                    return (
                      <QualifyTag
                        verdict={latest.responseVerdict}
                        sensitivity={round(latest.sensitivity, 2)}
                        size="small"
                      />
                    );
                  },
                },
                {
                  title: '距下次标定',
                  width: 130,
                  render: (_: unknown, inst: Installation) => {
                    const device = allInstruments.find((ins) => ins.serialNo === inst.serialNo);
                    if (!device) return <span className="gb-hint">—</span>;
                    const days = daysUntilDue(null, device.qualifyExpiryDate);
                    return (
                      <span className={days < 0 ? 'gb-danger gb-mono' : 'gb-mono'}>
                        {days < 0 ? `超期 ${Math.abs(days)} 天` : `剩余 ${days} 天`}
                      </span>
                    );
                  },
                },
                {
                  title: '操作',
                  width: 280,
                  render: (_: unknown, inst: Installation) => {
                    const device = allInstruments.find((ins) => ins.serialNo === inst.serialNo);
                    return (
                      <Space size={6}>
                        <Button size="small" type="primary" icon={<SwapOutlined />} onClick={() => openSwap(inst)}>
                          换机
                        </Button>
                        {inst.syncStatus === '待认' ? (
                          <>
                            <Button size="small" onClick={() => openMissing(inst)}>
                              补建
                            </Button>
                            <Button
                              size="small"
                              onClick={() =>
                                void dispatch(acknowledgeInstallation(inst.id)).then(() =>
                                  message.success('已认过：该安装位与计量站台账一致')
                                )
                              }
                            >
                              认过
                            </Button>
                          </>
                        ) : null}
                        {device ? (
                          <Button size="small" onClick={() => openInstrumentEdit(activeStation, device)}>
                            编辑
                          </Button>
                        ) : null}
                        <Popconfirm
                          title="删除安装位"
                          description="安装位删除后不可恢复；物理仪器与历次标定保留（跟原序列号走）。确认删除？"
                          okText="删除"
                          cancelText="取消"
                          okButtonProps={{ danger: true }}
                          onConfirm={() =>
                            void dispatch(removeInstallation(inst.id))
                              .unwrap()
                              .then(() => message.success('安装位已删除，物理仪器与标定保留'))
                          }
                        >
                          <Button size="small" danger>
                            删除
                          </Button>
                        </Popconfirm>
                      </Space>
                    );
                  },
                },
              ]}
            />
          )}
        </Card>
      ) : (
        <Card className="gb-panel" size="small">
          <EmptyPanel
            title="请选择台站查看安装位"
            description="在上表点击任一「安装位 / 在位数」或「登记仪器」按钮，即可查看与维护该台站的安装位。"
            compact
          />
        </Card>
      )}

      <p className="gb-hint">
        更换提醒：当仪器标定超期或结论不合格时，可到「合格评定与更换」页登记更换并跟踪到复核闭环；
        换机后安装位保留、序列号落到新的一台，历次标定跟原序列号走。当前共 {replaces.length} 条更换记录，
        {pendingSync > 0 ? <span className="gb-danger"> {pendingSync} 条待认</span> : ' 无待认缺口'}。
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
        open={instrumentModalOpen}
        title={`${editingInstrumentId ? '编辑' : '登记'}仪器 · ${activeStation?.code ?? ''}`}
        onCancel={() => setInstrumentModalOpen(false)}
        onOk={() => void submitInstrument()}
        confirmLoading={submitting}
        okText={editingInstrumentId ? '保存修改' : '登记并生成安装位'}
        destroyOnClose
      >
        <Form form={instrumentForm} layout="vertical" preserve={false}>
          <Form.Item name="channel" label="通道（安装位标识）" rules={[{ required: true, message: '请填写通道' }]}>
            <Input placeholder="如：宽频带 / 短周期 / 强震" maxLength={20} disabled={Boolean(editingInstrumentId)} />
          </Form.Item>
          <Form.Item name="type" label="仪器类型" rules={[{ required: true }]}>
            <Select
              options={INSTRUMENT_TYPES.map((type) => ({ label: type, value: type }))}
              onChange={(value: InstrumentType) => {
                const models = COMMON_MODELS[value] ?? [];
                instrumentForm.setFieldValue('model', models[0] ?? '');
              }}
            />
          </Form.Item>
          <Form.Item name="model" label="型号" rules={[{ required: true, message: '请填写型号' }]}>
            <Input placeholder="如：CMG-3ESPC" maxLength={40} />
          </Form.Item>
          <Form.Item
            name="serialNo"
            label="序列号（全局唯一，计量站台账按此记账）"
            rules={[{ required: true, message: '请填写序列号' }]}
          >
            <Input placeholder="如：CMG-3E-20210418-01" maxLength={60} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="installDate" label="安装日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} disabled={Boolean(editingInstrumentId)} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="state" label="状态" rules={[{ required: true }]}>
                <Select options={INSTRUMENT_STATES.map((state) => ({ label: state, value: state }))} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={80} placeholder="如：井下安装，深度 42 m" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={swapModalOpen}
        title={`换机 · ${swapInstallation?.channel ?? ''}（安装位保留）`}
        onCancel={() => setSwapModalOpen(false)}
        onOk={() => void submitSwap()}
        confirmLoading={submitting}
        okText="确认换机"
        destroyOnClose
      >
        <p className="gb-hint" style={{ marginBottom: 12 }}>
          换机后安装位保留，序列号落到新的一台；原设备历次标定跟原序列号走，不删除。
          若新序列号未在计量站台账登记，安装位将挂「待认」，认过才算数。
        </p>
        <Form form={swapForm} layout="vertical" preserve={false}>
          <Form.Item label="当前序列号">
            <span className="gb-mono">{swapInstallation?.serialNo}</span>
          </Form.Item>
          <Form.Item name="newSerialNo" label="新序列号" rules={[{ required: true, message: '请填写新序列号' }]}>
            <Input placeholder="如：CMG-3E-20250410-33" maxLength={60} />
          </Form.Item>
          <Form.Item name="date" label="换机日期" rules={[{ required: true }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="reason" label="换机原因" rules={[{ required: true, message: '请填写换机原因' }]}>
            <Input.TextArea rows={2} maxLength={100} placeholder="如：超期未标定，按台网要求整机更换" />
          </Form.Item>
          <Form.Item name="operator" label="责任人" rules={[{ required: true, message: '请填写责任人' }]}>
            <Input maxLength={20} placeholder="如：周渝" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={missingModalOpen}
        title="补建物理仪器（计量站台账）"
        onCancel={() => setMissingModalOpen(false)}
        onOk={() => void submitMissing()}
        confirmLoading={submitting}
        okText="补建并认过"
        destroyOnClose
      >
        <p className="gb-hint" style={{ marginBottom: 12 }}>
          安装位 {missingInstallation?.channel} 的序列号 <span className="gb-mono">{missingInstallation?.serialNo}</span>{' '}
          尚未在计量站台账登记。补建物理仪器后安装位自动认账。
        </p>
        <Form form={missingForm} layout="vertical" preserve={false}>
          <Form.Item name="type" label="仪器类型" rules={[{ required: true }]}>
            <Select options={INSTRUMENT_TYPES.map((type) => ({ label: type, value: type }))} />
          </Form.Item>
          <Form.Item name="model" label="型号" rules={[{ required: true, message: '请填写型号' }]}>
            <Input placeholder="如：CMG-3ESPC" maxLength={40} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
