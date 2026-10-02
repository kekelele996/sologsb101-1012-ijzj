/**
 * 计量站：/calibrations 标定记录台
 * 录入灵敏度 / 自噪 / 脉冲响应结论并批量改结论；标定按物理仪器序列号挂，
 * 保存后自动重算该序列号合格到期日。换机前后历史都跟序列号走。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  App as AntdApp,
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
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import FilterBar from '@/components/common/FilterBar';
import type { FilterModel } from '@/types/filter';
import StatBadge from '@/components/common/StatBadge';
import QualifyTag from '@/components/common/QualifyTag';
import EmptyPanel from '@/components/common/EmptyPanel';
import { ROUTES } from '@/router';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectStations } from '@/stores/arraySlice';
import { selectInstalls } from '@/stores/installSlice';
import { selectDevices } from '@/stores/deviceSlice';
import {
  bulkSetVerdict,
  createCalibration,
  patchFilter,
  removeCalibration,
  resetFilter,
  selectCalibrationFilter,
  selectCalibrations,
  updateCalibration,
} from '@/stores/calibrationSlice';
import {
  RESPONSE_VERDICTS,
  SELF_NOISE_LIMIT,
  SENSITIVITY_RANGE,
  judgeCalibration,
  sensitivityDelta,
  type Calibration,
  type ResponseVerdict,
} from '@/types/calibration';
import { INSTRUMENT_TYPES } from '@/types/device';
import type { InstrumentType } from '@/types/device';
import { round } from '@/utils/geo';
import { initDatabase } from '@/utils/db';

interface CalibrationFormValues {
  serialNo: string;
  date: dayjs.Dayjs | null;
  sensitivity: number;
  selfNoise: number;
  responseVerdict: ResponseVerdict;
  operator: string;
  agency: string;
  remark: string;
}

/** 标定行：附带物理仪器、当前台站信息与灵敏度变化 */
interface CalibrationRow {
  row: Calibration;
  deviceModel: string;
  deviceType: string;
  stationCode: string;
  arrayName: string;
  delta: ReturnType<typeof sensitivityDelta>;
}

export default function CalibrationBoard() {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();
  const [searchParams, setSearchParams] = useSearchParams();

  const calibrations = useAppSelector(selectCalibrations);
  const devices = useAppSelector(selectDevices);
  const installs = useAppSelector(selectInstalls);
  const stations = useAppSelector(selectStations);
  const filter = useAppSelector(selectCalibrationFilter);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [trendSerial, setTrendSerial] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<CalibrationFormValues>();

  useEffect(() => {
    dispatch(
      patchFilter({
        keyword: searchParams.get('kw') ?? '',
        verdicts: (searchParams.get('verdict')?.split(',').filter(Boolean) ?? []) as ResponseVerdict[],
        instrumentTypes: searchParams.get('type')?.split(',').filter(Boolean) ?? [],
        onlyUnqualified: searchParams.get('bad') === '1',
      })
    );
    if (devices.length === 0) void initDatabase();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const arrays = useAppSelector((state) => state.array.arrays);

  /** 序列号 → 设备与当前安装位信息 */
  const infoBySerial = useMemo(() => {
    const installBySerial = new Map(installs.map((install) => [install.serialNo, install]));
    const stationById = new Map(stations.map((station) => [station.id, station]));
    const arrayById = new Map(arrays.map((array) => [array.id, array]));
    const map = new Map<string, { model: string; type: string; stationCode: string; arrayName: string }>();
    devices.forEach((device) => {
      const install = installBySerial.get(device.serialNo);
      const station = install ? stationById.get(install.stationId) : undefined;
      const array = station ? arrayById.get(station.arrayId) : undefined;
      map.set(device.serialNo, {
        model: device.model,
        type: device.type,
        stationCode: station ? `${station.code}·${install?.channel ?? ''}` : '库存 / 已拆下',
        arrayName: array?.name ?? '—',
      });
    });
    return map;
  }, [arrays, devices, installs, stations]);

  /** 逐序列号排序后的标定，用于灵敏度变化 */
  const deltaIndex = useMemo(() => {
    const grouped = new Map<string, Calibration[]>();
    calibrations.forEach((row) => {
      const list = grouped.get(row.serialNo) ?? [];
      list.push(row);
      grouped.set(row.serialNo, list);
    });
    const result = new Map<string, ReturnType<typeof sensitivityDelta>>();
    grouped.forEach((list) => {
      const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
      sorted.forEach((row, index) => {
        result.set(row.id, sensitivityDelta(row.sensitivity, index > 0 ? sorted[index - 1].sensitivity : null));
      });
    });
    return result;
  }, [calibrations]);

  const rows = useMemo<CalibrationRow[]>(() => {
    return calibrations
      .map((row) => {
        const info = infoBySerial.get(row.serialNo);
        return {
          row,
          deviceModel: info?.model ?? '设备档案缺失（已挂账）',
          deviceType: info?.type ?? '未知',
          stationCode: info?.stationCode ?? '—',
          arrayName: info?.arrayName ?? '—',
          delta: deltaIndex.get(row.id) ?? sensitivityDelta(row.sensitivity, null),
        };
      })
      .filter((item) => {
        const keyword = filter.keyword.trim();
        if (keyword.length > 0) {
          const haystack = `${item.deviceModel}${item.row.serialNo}${item.stationCode}${item.arrayName}${item.row.operator}${item.row.agency}`;
          if (!haystack.includes(keyword)) return false;
        }
        if (filter.verdicts.length > 0 && !filter.verdicts.includes(item.row.responseVerdict)) return false;
        if (filter.instrumentTypes.length > 0 && !filter.instrumentTypes.includes(item.deviceType)) return false;
        if (filter.onlyUnqualified && item.row.responseVerdict !== '不合格') return false;
        return true;
      })
      .sort((a, b) => b.row.date.localeCompare(a.row.date));
  }, [calibrations, deltaIndex, filter, infoBySerial]);

  const totals = useMemo(() => {
    const unqualified = rows.filter((item) => item.row.responseVerdict === '不合格').length;
    const meanSensitivity =
      rows.length === 0 ? 0 : round(rows.reduce((sum, item) => sum + item.row.sensitivity, 0) / rows.length, 1);
    const meanNoise =
      rows.length === 0 ? 0 : round(rows.reduce((sum, item) => sum + item.row.selfNoise, 0) / rows.length, 2);
    return {
      count: rows.length,
      unqualified,
      qualifyRate: rows.length === 0 ? 0 : round(((rows.length - unqualified) / rows.length) * 100, 1),
      meanSensitivity,
      meanNoise,
      operatorCount: new Set(rows.map((item) => item.row.operator)).size,
    };
  }, [rows]);

  const filterModel: FilterModel = {
    keyword: filter.keyword,
    verdicts: filter.verdicts,
    instrumentTypes: filter.instrumentTypes,
  };

  const trendPoints = useMemo(
    () =>
      calibrations
        .filter((row) => row.serialNo === (trendSerial ?? devices[0]?.serialNo ?? ''))
        .sort((a, b) => a.date.localeCompare(b.date)),
    [calibrations, devices, trendSerial]
  );
  const trendSerialResolved = trendSerial ?? devices[0]?.serialNo ?? null;

  const openCreate = () => {
    setEditingId(null);
    const firstDevice = devices[0];
    const type = (firstDevice?.type ?? '宽频带') as InstrumentType;
    const range = SENSITIVITY_RANGE[type];
    form.setFieldsValue({
      serialNo: firstDevice?.serialNo ?? '',
      date: dayjs(),
      sensitivity: round((range.min + range.max) / 2, 2),
      selfNoise: 1.5,
      responseVerdict: '合格',
      operator: '陈立群',
      agency: '省地震局计量站',
      remark: '',
    });
    setModalOpen(true);
  };

  const openEdit = (row: Calibration) => {
    setEditingId(row.id);
    form.setFieldsValue({
      serialNo: row.serialNo,
      date: dayjs(row.date),
      sensitivity: row.sensitivity,
      selfNoise: row.selfNoise,
      responseVerdict: row.responseVerdict,
      operator: row.operator,
      agency: row.agency,
      remark: row.remark,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      const payload = {
        serialNo: values.serialNo.trim(),
        date: values.date ? values.date.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
        sensitivity: Number(values.sensitivity),
        selfNoise: Number(values.selfNoise),
        responseVerdict: values.responseVerdict,
        operator: values.operator.trim(),
        agency: values.agency?.trim() ?? '',
        remark: values.remark?.trim() ?? '',
      };
      if (editingId) {
        await dispatch(updateCalibration({ id: editingId, patch: payload })).unwrap();
        message.success('标定记录已更新，合格到期日已重算');
      } else {
        await dispatch(createCalibration(payload)).unwrap();
        const device = devices.find((row) => row.serialNo === payload.serialNo);
        const verdict = judgeCalibration(device?.type ?? '宽频带', payload.sensitivity, payload.selfNoise);
        message.success(`标定记录已保存，自动初判为「${verdict}」`);
      }
      setModalOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handleBulkVerdict = async (verdict: ResponseVerdict) => {
    if (selectedKeys.length === 0) {
      message.warning('请先勾选要批量改结论的记录');
      return;
    }
    await dispatch(bulkSetVerdict({ ids: selectedKeys, verdict })).unwrap();
    message.success(`已将 ${selectedKeys.length} 条标定记录的响应结论改为「${verdict}」`);
    setSelectedKeys([]);
  };

  const handleFilterChange = (next: FilterModel, switchValue: boolean) => {
    dispatch(
      patchFilter({
        keyword: next.keyword,
        verdicts: ((next.verdicts as string[]) ?? []) as ResponseVerdict[],
        instrumentTypes: (next.instrumentTypes as string[]) ?? [],
        onlyUnqualified: switchValue,
      })
    );
    const params = new URLSearchParams();
    if (next.keyword.trim()) params.set('kw', next.keyword.trim());
    if (((next.verdicts as string[]) ?? []).length > 0) params.set('verdict', ((next.verdicts as string[]) ?? []).join(','));
    if (((next.instrumentTypes as string[]) ?? []).length > 0)
      params.set('type', ((next.instrumentTypes as string[]) ?? []).join(','));
    if (switchValue) params.set('bad', '1');
    setSearchParams(params, { replace: true });
  };

  const handleReset = () => {
    dispatch(resetFilter());
    setSearchParams(new URLSearchParams(), { replace: true });
  };

  const trendChart = useMemo(() => {
    const points = trendPoints;
    if (points.length === 0) {
      return { line: '', dots: [] as Array<{ id: string; cx: number; cy: number; date: string; sensitivity: number }> };
    }
    const sensitivities = points.map((row) => row.sensitivity);
    const min = Math.min(...sensitivities) * 0.98;
    const max = Math.max(...sensitivities) * 1.02;
    const left = 58;
    const right = 340;
    const top = 20;
    const bottom = 190;
    const toX = (index: number): number =>
      points.length === 1 ? (left + right) / 2 : left + (index * (right - left)) / (points.length - 1);
    const toY = (value: number): number =>
      max - min < 1e-6 ? (top + bottom) / 2 : bottom - ((value - min) / (max - min)) * (bottom - top);
    const dots = points.map((row, index) => ({
      id: row.id,
      cx: Number(toX(index).toFixed(1)),
      cy: Number(toY(row.sensitivity).toFixed(1)),
      date: row.date,
      sensitivity: row.sensitivity,
    }));
    return { line: dots.map((dot) => `${dot.cx},${dot.cy}`).join(' '), dots };
  }, [trendPoints]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            标定记录台（计量站）
          </Typography.Title>
          <p className="gb-hint">
            按物理仪器序列号录入标定；系统按类型灵敏度区间（宽频带 {SENSITIVITY_RANGE.宽频带.min} ~{' '}
            {SENSITIVITY_RANGE.宽频带.max}）与自噪限值（{SELF_NOISE_LIMIT}）自动初判，并回写合格到期日。
          </p>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void initDatabase()}>
            补齐演示数据
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增标定记录
          </Button>
        </Space>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="标定记录" value={totals.count} suffix="次" tone="primary" />
        <StatBadge label="不合格" value={totals.unqualified} suffix="次" tone={totals.unqualified > 0 ? 'danger' : 'success'} />
        <StatBadge label="记录合格率" value={totals.qualifyRate} percent={totals.qualifyRate} tone="success" />
        <StatBadge label="平均灵敏度" value={totals.meanSensitivity} suffix="V·s/m" tone="info" />
        <StatBadge label="平均自噪" value={totals.meanNoise} suffix="" tone="warning" />
        <StatBadge label="标定人" value={totals.operatorCount} suffix="人" tone="default" />
      </div>

      <FilterBar
        modelValue={filterModel}
        selects={[
          { key: 'verdicts', label: '响应结论', options: RESPONSE_VERDICTS.map((verdict) => ({ label: verdict, value: verdict })) },
          { key: 'instrumentTypes', label: '仪器类型', options: INSTRUMENT_TYPES.map((type) => ({ label: type, value: type })) },
        ]}
        hasSwitch
        switchLabel="仅看不合格记录"
        switchValue={filter.onlyUnqualified}
        keywordPlaceholder="搜索型号 / 序列号 / 台站 / 标定人"
        onChange={handleFilterChange}
        onReset={handleReset}
        extra={
          <Space size={6}>
            <span className="gb-hint">批量改结论：</span>
            {RESPONSE_VERDICTS.map((verdict) => (
              <Button key={verdict} size="small" onClick={() => void handleBulkVerdict(verdict)}>
                {verdict}
              </Button>
            ))}
          </Space>
        }
      />

      {rows.length === 0 ? (
        <EmptyPanel
          title={calibrations.length === 0 ? '还没有标定记录' : '没有符合条件的标定记录'}
          description="先在物理仪器台账建档（或认领挂账序列号），再按序列号录入标定。"
          actionText="新增标定记录"
          secondaryText="物理仪器台账"
          onAction={openCreate}
          onSecondary={() => navigate(ROUTES.devices)}
        />
      ) : (
        <Table
          rowKey={(item) => item.row.id}
          className="gb-table-compact"
          dataSource={rows}
          pagination={{ pageSize: 12, showSizeChanger: false }}
          rowSelection={{ selectedRowKeys: selectedKeys, onChange: (keys) => setSelectedKeys(keys as string[]) }}
          columns={[
            {
              title: '物理仪器',
              width: 210,
              render: (_: unknown, item: CalibrationRow) => (
                <div>
                  <div>
                    {item.deviceModel} <Tag>{item.deviceType}</Tag>
                  </div>
                  <div className="gb-hint gb-mono">{item.row.serialNo}</div>
                </div>
              ),
            },
            {
              title: '当前台站 / 台阵',
              width: 170,
              render: (_: unknown, item: CalibrationRow) => (
                <div>
                  <div className="gb-mono">{item.stationCode}</div>
                  <div className="gb-hint">{item.arrayName}</div>
                </div>
              ),
            },
            { title: '标定日期', dataIndex: ['row', 'date'], width: 110, className: 'gb-mono' },
            {
              title: '灵敏度 (V·s/m)',
              width: 150,
              align: 'right',
              render: (_: unknown, item: CalibrationRow) => (
                <div>
                  <span className="gb-mono">{item.row.sensitivity}</span>
                  {item.delta.comparable ? (
                    <div className={Math.abs(item.delta.percent) > 5 ? 'gb-danger gb-hint' : 'gb-hint'}>
                      变化 {item.delta.absolute > 0 ? '+' : ''}
                      {item.delta.absolute}（{item.delta.percent}%）
                    </div>
                  ) : (
                    <div className="gb-hint">首次标定</div>
                  )}
                </div>
              ),
            },
            {
              title: '自噪',
              width: 90,
              align: 'right',
              render: (_: unknown, item: CalibrationRow) => (
                <span className={item.row.selfNoise > SELF_NOISE_LIMIT ? 'gb-danger gb-mono' : 'gb-mono'}>
                  {item.row.selfNoise}
                </span>
              ),
            },
            {
              title: '响应结论',
              width: 180,
              render: (_: unknown, item: CalibrationRow) => (
                <QualifyTag verdict={item.row.responseVerdict} sensitivity={item.row.sensitivity} selfNoise={item.row.selfNoise} size="small" />
              ),
            },
            {
              title: '标定人 / 机构',
              width: 160,
              render: (_: unknown, item: CalibrationRow) => (
                <div>
                  <div>{item.row.operator || '未署名'}</div>
                  <div className="gb-hint">{item.row.agency || '未填写机构'}</div>
                </div>
              ),
            },
            { title: '备注', dataIndex: ['row', 'remark'], ellipsis: true },
            {
              title: '操作',
              width: 180,
              render: (_: unknown, item: CalibrationRow) => (
                <Space size={6}>
                  <Button size="small" onClick={() => setTrendSerial(item.row.serialNo)}>
                    趋势
                  </Button>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(item.row)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除标定记录"
                    description="删除后该序列号合格到期日会重算，确认？"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() =>
                      void dispatch(removeCalibration(item.row.id))
                        .unwrap()
                        .then(() => message.success('标定记录已删除'))
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

      <Card
        className="gb-panel"
        size="small"
        title="灵敏度趋势（按序列号）"
        extra={
          <Select
            showSearch
            optionFilterProp="label"
            style={{ width: 300 }}
            placeholder="选择物理仪器序列号"
            value={trendSerialResolved ?? undefined}
            onChange={(value) => setTrendSerial(value)}
            options={devices.map((device) => ({
              label: `${device.model}（${device.serialNo}）`,
              value: device.serialNo,
            }))}
          />
        }
      >
        {trendChart.dots.length === 0 ? (
          <EmptyPanel title="暂无可绘制的趋势" description="该序列号还没有标定记录。" compact />
        ) : (
          <>
            <svg viewBox="0 0 380 220" className="gb-chart">
              <line x1="58" y1="190" x2="352" y2="190" stroke="#b9c6d4" />
              <line x1="58" y1="20" x2="58" y2="190" stroke="#b9c6d4" />
              <polyline points={trendChart.line} fill="none" stroke="#1e3a5f" strokeWidth="2" />
              {trendChart.dots.map((dot) => (
                <g key={dot.id}>
                  <circle cx={dot.cx} cy={dot.cy} r="4.5" fill="#7fd1e8" stroke="#1e3a5f" />
                  <text x={dot.cx - 22} y={216} className="gb-chart-axis">
                    {dot.date.slice(2)}
                  </text>
                </g>
              ))}
            </svg>
            <p className="gb-hint">纵轴为灵敏度（V·s/m），横轴为标定日期；共 {trendChart.dots.length} 次标定，换机前后均挂同一序列号。</p>
          </>
        )}
      </Card>

      <Modal
        open={modalOpen}
        title={editingId ? '编辑标定记录' : '新增标定记录'}
        onCancel={() => setModalOpen(false)}
        onOk={() => void submit()}
        confirmLoading={submitting}
        okText={editingId ? '保存修改' : '保存并初判'}
        width={640}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="serialNo" label="被标定仪器序列号" rules={[{ required: true, message: '请选择物理仪器' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={[
                ...devices.map((device) => {
                  const info = infoBySerial.get(device.serialNo);
                  return {
                    label: `${info?.arrayName ?? ''} / ${info?.stationCode ?? '库存'} · ${device.model}（${device.serialNo}）`,
                    value: device.serialNo,
                  };
                }),
              ]}
              onChange={(value: string) => {
                const device = devices.find((row) => row.serialNo === value);
                const range = SENSITIVITY_RANGE[device?.type ?? '宽频带'];
                form.setFieldValue('sensitivity', round((range.min + range.max) / 2, 2));
              }}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="date" label="标定日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="responseVerdict" label="脉冲响应结论" rules={[{ required: true }]}>
                <Select options={RESPONSE_VERDICTS.map((verdict) => ({ label: verdict, value: verdict }))} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="sensitivity" label="灵敏度 (V·s/m)" rules={[{ required: true }]}>
                <InputNumber min={0} max={100000} step={0.01} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="selfNoise" label={`自噪（限值 ${SELF_NOISE_LIMIT}）`} rules={[{ required: true }]}>
                <InputNumber min={0} max={100} step={0.01} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="operator" label="标定人" rules={[{ required: true, message: '请填写标定人' }]}>
                <Input maxLength={20} placeholder="如：陈立群" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="agency" label="标定机构">
                <Input maxLength={40} placeholder="如：省地震局计量站" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={100} placeholder="如：响应曲线平滑 / 自噪接近上限" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
