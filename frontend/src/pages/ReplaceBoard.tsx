/**
 * 合格评定与更换（两侧协作）：
 * 上方按安装位评估「当前那台」设备的合格到期情况；换机后评估对象自动换成新序列号。
 * 登记更换并推进 待更换 → 已更换 → 已复核：
 * 到「已更换」时安装位保留、序列号落到新设备，旧设备标定仍挂旧序列号。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, WarningFilled } from '@ant-design/icons';
import dayjs from 'dayjs';
import FilterBar from '@/components/common/FilterBar';
import type { FilterModel } from '@/types/filter';
import StatBadge from '@/components/common/StatBadge';
import QualifyTag from '@/components/common/QualifyTag';
import EmptyPanel from '@/components/common/EmptyPanel';
import { ROUTES } from '@/router';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectArrays, selectStations } from '@/stores/arraySlice';
import { selectInstalls } from '@/stores/installSlice';
import { selectDevices } from '@/stores/deviceSlice';
import {
  createReplace,
  patchReplaceFilter,
  removeReplace,
  resetReplaceFilter,
  selectCalibrations,
  selectReplaceFilter,
  selectReplaces,
  transitionReplace,
  updateReplace,
} from '@/stores/calibrationSlice';
import {
  REPLACE_REASON_TEMPLATES,
  REPLACE_STATES,
  REPLACE_TRANSITIONS,
  type Replace,
  type ReplaceState,
} from '@/types/replace';
import { useCalibHistory } from '@/hooks/useCalibHistory';
import { qualifyForInstall } from '@/utils/qualify';
import { initDatabase } from '@/utils/db';
import type { Install } from '@/types/install';

interface ReplaceFormValues {
  installId: string;
  reason: string;
  newSerialNo: string;
  date: dayjs.Dayjs | null;
  state: ReplaceState;
  operator: string;
  remark: string;
}

/** 安装位评定行 */
interface AssessmentRow {
  install: Install;
  stationCode: string;
  channel: string;
  arrayId: string;
  arrayName: string;
  model: string;
  serialNo: string;
  lastDate: string;
  dueInDays: number;
  overdue: boolean;
  lastVerdict: string;
  calibrationCount: number;
  replace: Replace | null;
}

export default function ReplaceBoard() {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const installs = useAppSelector(selectInstalls);
  const stations = useAppSelector(selectStations);
  const arrays = useAppSelector(selectArrays);
  const devices = useAppSelector(selectDevices);
  const calibrations = useAppSelector(selectCalibrations);
  const replaces = useAppSelector(selectReplaces);
  const filter = useAppSelector(selectReplaceFilter);
  const { histories } = useCalibHistory();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<ReplaceFormValues>();

  useEffect(() => {
    if (arrays.length === 0) void initDatabase();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const deviceBySerial = useMemo(
    () => new Map(devices.map((device) => [device.serialNo, device])),
    [devices]
  );

  /** 每个安装位最新的更换记录 */
  const latestReplaceByInstall = useMemo(() => {
    const map = new Map<string, Replace>();
    replaces
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date))
      .forEach((row) => {
        if (!map.has(row.installId)) map.set(row.installId, row);
      });
    return map;
  }, [replaces]);

  /** 安装位评定行：只看当前序列号那台设备 */
  const rows = useMemo<AssessmentRow[]>(() => {
    return installs
      .map((install) => {
        const station = stations.find((row) => row.id === install.stationId);
        const array = station ? arrays.find((row) => row.id === station.arrayId) : undefined;
        const q = qualifyForInstall(install, calibrations);
        const device = deviceBySerial.get(install.serialNo);
        return {
          install,
          stationCode: station?.code ?? '未知台站',
          channel: install.channel,
          arrayId: array?.id ?? station?.arrayId ?? '',
          arrayName: array?.name ?? '未知台阵',
          model: device?.model ?? '（序列号待认领）',
          serialNo: install.serialNo,
          lastDate: q.latest?.date ?? install.installDate,
          dueInDays: q.dueInDays,
          overdue: q.overdue,
          lastVerdict: q.verdict,
          calibrationCount: q.count,
          replace: latestReplaceByInstall.get(install.id) ?? null,
        };
      })
      .filter((row) => {
        const keyword = filter.keyword.trim();
        if (keyword.length > 0) {
          const haystack = `${row.model}${row.serialNo}${row.stationCode}${row.channel}${row.arrayName}`;
          if (!haystack.includes(keyword)) return false;
        }
        if (filter.arrayIds.length > 0 && !filter.arrayIds.includes(row.arrayId)) return false;
        if (filter.states.length > 0) {
          const state = row.replace?.state ?? '待更换';
          if (!filter.states.includes(state)) return false;
        }
        return true;
      })
      .sort((a, b) => a.dueInDays - b.dueInDays);
  }, [arrays, calibrations, deviceBySerial, filter, installs, latestReplaceByInstall, stations]);

  const totals = useMemo(() => {
    const overdue = rows.filter((row) => row.overdue).length;
    const unqualified = rows.filter((row) => row.lastVerdict === '不合格').length;
    const pendingReplace = replaces.filter((row) => row.state === '待更换').length;
    const closedReplace = replaces.filter((row) => row.state === '已复核').length;
    const cycleRate = rows.length === 0 ? 0 : Number((((rows.length - overdue) / rows.length) * 100).toFixed(1));
    return { installs: rows.length, overdue, unqualified, pendingReplace, closedReplace, cycleRate };
  }, [replaces, rows]);

  /** 更换记录跟踪表（带当前台站信息） */
  const replaceRows = useMemo(
    () =>
      replaces
        .map((row) => {
          const install = installs.find((item) => item.id === row.installId);
          const station = install ? stations.find((item) => item.id === install.stationId) : undefined;
          const array = station ? arrays.find((item) => item.id === station.arrayId) : undefined;
          return {
            row,
            channel: install?.channel ?? '—',
            stationCode: station?.code ?? '安装位已删除',
            arrayName: array?.name ?? '—',
          };
        })
        .sort((a, b) => b.row.date.localeCompare(a.row.date)),
    [arrays, installs, replaces, stations]
  );

  const filterModel: FilterModel = { keyword: filter.keyword, states: filter.states, arrayIds: filter.arrayIds };

  const openCreate = (installId?: string) => {
    setEditingId(null);
    form.setFieldsValue({
      installId: installId ?? installs[0]?.id ?? '',
      reason: REPLACE_REASON_TEMPLATES[0].reason,
      newSerialNo: '',
      date: dayjs(),
      state: '待更换',
      operator: '周渝',
      remark: '',
    });
    setModalOpen(true);
  };

  const openEdit = (row: Replace) => {
    setEditingId(row.id);
    form.setFieldsValue({
      installId: row.installId,
      reason: row.reason,
      newSerialNo: row.newSerialNo,
      date: dayjs(row.date),
      state: row.state,
      operator: row.operator,
      remark: row.remark,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      const payload = {
        installId: values.installId,
        reason: values.reason.trim(),
        newSerialNo: values.newSerialNo.trim(),
        date: values.date ? values.date.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
        state: values.state,
        operator: values.operator.trim(),
        remark: values.remark?.trim() ?? '',
      };
      if (editingId) {
        await dispatch(updateReplace({ id: editingId, patch: payload })).unwrap();
        message.success('更换记录已更新');
      } else {
        await dispatch(createReplace(payload)).unwrap();
        message.success('更换记录已登记，可在下方推进状态机');
      }
      setModalOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const advance = async (row: Replace, next: ReplaceState) => {
    try {
      await dispatch(transitionReplace({ id: row.id, next })).unwrap();
      message.success(
        next === '已更换'
          ? '换机完成：安装位保留，序列号已落到新设备；旧设备历次标定仍挂旧序列号'
          : `更换记录状态已流转到「${next}」`
      );
    } catch (error) {
      message.error(typeof error === 'string' ? error : '状态流转失败');
    }
  };

  /** 超期安装位提醒 */
  const overdueHistories = histories.filter((history) => history.overdue);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            合格评定与更换提醒
          </Typography.Title>
          <p className="gb-hint">
            按安装位当前设备的合格到期日（标定周期 365 天）与最近结论评定；换机后安装位保留、序列号落到新设备，
            评定自动跟着新序列号重算。
          </p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>
          登记更换
        </Button>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="安装位" value={totals.installs} suffix="个" tone="primary" />
        <StatBadge label="超期未标定" value={totals.overdue} suffix="个" tone={totals.overdue > 0 ? 'danger' : 'success'} />
        <StatBadge label="当前设备不合格" value={totals.unqualified} suffix="个" tone={totals.unqualified > 0 ? 'warning' : 'success'} />
        <StatBadge label="按期率" value={totals.cycleRate} percent={totals.cycleRate} tone="success" />
        <StatBadge label="待更换" value={totals.pendingReplace} suffix="条" tone="warning" />
        <StatBadge label="已复核" value={totals.closedReplace} suffix="条" tone="info" />
      </div>

      {overdueHistories.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          icon={<WarningFilled />}
          message={`存在 ${overdueHistories.length} 台在装设备合格到期未标定，请优先安排标定或登记更换`}
          description={overdueHistories
            .slice(0, 5)
            .map(
              (history) =>
                `${history.arrayName} / ${history.stationCode} · ${history.device.model}（${history.device.serialNo}）已超期 ${Math.abs(history.dueInDays)} 天`
            )
            .join('；')}
        />
      ) : (
        <Alert type="success" showIcon message="全部在装设备均在标定周期内，无需特别提醒" />
      )}

      <FilterBar
        modelValue={filterModel}
        selects={[
          { key: 'states', label: '更换状态', options: REPLACE_STATES.map((state) => ({ label: state, value: state })) },
          { key: 'arrayIds', label: '所属台阵', options: arrays.map((array) => ({ label: array.name, value: array.id })) },
        ]}
        keywordPlaceholder="搜索型号 / 序列号 / 台站 / 通道"
        onChange={(next) =>
          dispatch(
            patchReplaceFilter({
              keyword: next.keyword,
              states: ((next.states as string[]) ?? []) as ReplaceState[],
              arrayIds: (next.arrayIds as string[]) ?? [],
            })
          )
        }
        onReset={() => dispatch(resetReplaceFilter())}
      />

      {rows.length === 0 ? (
        <EmptyPanel
          title={installs.length === 0 ? '还没有安装位' : '没有符合条件的安装位'}
          description="先到「台站安装位」页登记通道与序列号，再回本页评定与登记更换。"
          actionText="登记更换"
          secondaryText="去安装位"
          onAction={() => openCreate()}
          onSecondary={() => navigate(ROUTES.arrays)}
        />
      ) : (
        <Table
          rowKey={(row) => row.install.id}
          className="gb-table-compact"
          dataSource={rows}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          rowClassName={(row) => (row.overdue || row.lastVerdict === '不合格' ? 'gb-row-danger' : '')}
          columns={[
            {
              title: '台站 / 通道',
              width: 160,
              render: (_: unknown, row: AssessmentRow) => (
                <div>
                  <div className="gb-mono">{row.stationCode}</div>
                  <Tag color="blue">{row.channel}</Tag>
                </div>
              ),
            },
            {
              title: '当前设备',
              width: 230,
              render: (_: unknown, row: AssessmentRow) => (
                <div>
                  <div>{row.model}</div>
                  <div className="gb-hint gb-mono">{row.serialNo}</div>
                </div>
              ),
            },
            {
              title: '最近标定',
              width: 120,
              render: (_: unknown, row: AssessmentRow) => (
                <div>
                  <div className="gb-mono">{row.lastDate}</div>
                  <div className="gb-hint">{row.calibrationCount} 次记录</div>
                </div>
              ),
            },
            {
              title: '合格到期',
              width: 160,
              render: (_: unknown, row: AssessmentRow) => (
                <span className={row.overdue ? 'gb-danger gb-mono' : 'gb-mono'}>
                  {row.overdue ? `超期 ${Math.abs(row.dueInDays)} 天` : `剩余 ${row.dueInDays} 天`}
                </span>
              ),
            },
            {
              title: '最近结论',
              width: 140,
              render: (_: unknown, row: AssessmentRow) => <QualifyTag verdict={row.lastVerdict as never} size="small" />,
            },
            {
              title: '安装位状态',
              width: 110,
              render: (_: unknown, row: AssessmentRow) => (
                <Tag color={row.install.state === '在用' ? 'green' : row.install.state === '待标定' ? 'orange' : 'default'}>
                  {row.install.state}
                </Tag>
              ),
            },
            {
              title: '更换状态',
              width: 150,
              render: (_: unknown, row: AssessmentRow) =>
                row.replace ? (
                  <div>
                    <Tag color={row.replace.state === '已复核' ? 'green' : row.replace.state === '已更换' ? 'blue' : 'orange'}>
                      {row.replace.state}
                    </Tag>
                    <div className="gb-hint">{row.replace.date}</div>
                  </div>
                ) : (
                  <span className="gb-hint">未登记更换</span>
                ),
            },
            {
              title: '操作',
              width: 250,
              render: (_: unknown, row: AssessmentRow) => (
                <Space size={6}>
                  <Button size="small" type="primary" onClick={() => openCreate(row.install.id)}>
                    登记更换
                  </Button>
                  {row.replace ? (
                    <>
                      {(REPLACE_TRANSITIONS[row.replace.state] ?? []).slice(0, 1).map((next) => (
                        <Button key={next} size="small" onClick={() => void advance(row.replace as Replace, next)}>
                          → {next}
                        </Button>
                      ))}
                      <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row.replace as Replace)}>
                        编辑
                      </Button>
                    </>
                  ) : null}
                </Space>
              ),
            },
          ]}
        />
      )}

      <Card className="gb-panel" size="small" title={`更换记录跟踪（${replaceRows.length} 条）`}>
        {replaceRows.length === 0 ? (
          <EmptyPanel
            title="还没有更换记录"
            description="对超期或不合格安装位点「登记更换」，换机后序列号落到新设备、安装位保留。"
            actionText="登记更换"
            onAction={() => openCreate()}
            compact
          />
        ) : (
          <Table
            rowKey={(item) => item.row.id}
            size="small"
            className="gb-table-compact"
            dataSource={replaceRows}
            pagination={false}
            columns={[
              {
                title: '安装位 / 通道',
                width: 150,
                render: (_: unknown, item) => (
                  <div>
                    <div className="gb-mono">{item.stationCode}</div>
                    <Tag color="blue">{item.channel}</Tag>
                  </div>
                ),
              },
              {
                title: '旧序列号 → 新序列号',
                width: 300,
                render: (_: unknown, item) => (
                  <div className="gb-mono">
                    <span>{item.row.fromSerialNo || '—'}</span>
                    <span style={{ margin: '0 6px' }}>→</span>
                    <b>{item.row.newSerialNo || '未填新序列号'}</b>
                  </div>
                ),
              },
              { title: '更换原因', dataIndex: ['row', 'reason'], ellipsis: true },
              { title: '日期', dataIndex: ['row', 'date'], width: 110, className: 'gb-mono' },
              {
                title: '状态',
                width: 110,
                render: (_: unknown, item) => (
                  <Tag color={item.row.state === '已复核' ? 'green' : item.row.state === '已更换' ? 'blue' : 'orange'}>
                    {item.row.state}
                  </Tag>
                ),
              },
              { title: '责任人', dataIndex: ['row', 'operator'], width: 90 },
              {
                title: '操作',
                width: 280,
                render: (_: unknown, item) => (
                  <Space size={6}>
                    {(REPLACE_TRANSITIONS[item.row.state] ?? []).map((next) => (
                      <Button key={next} size="small" onClick={() => void advance(item.row, next)}>
                        → {next}
                      </Button>
                    ))}
                    <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(item.row)}>
                      编辑
                    </Button>
                    <Popconfirm
                      title="删除更换记录"
                      description="仅删除流转记录；已认过的序列号归属不退回，确认？"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() =>
                        void dispatch(removeReplace(item.row.id))
                          .unwrap()
                          .then(() => message.success('更换记录已删除'))
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
      </Card>

      <p className="gb-hint">
        点「→ 已更换」后安装位保留、序列号落到新设备并按新机日重算到期；旧序列号的历次标定不带走。
        新序列号若计量站尚无档案，会自动进
        <Button type="link" size="small" onClick={() => navigate(ROUTES.claims)}>
          序列号对账
        </Button>
        待认领。
      </p>

      <Modal
        open={modalOpen}
        title={editingId ? '编辑更换记录' : '登记更换'}
        onCancel={() => setModalOpen(false)}
        onOk={() => void submit()}
        confirmLoading={submitting}
        okText={editingId ? '保存修改' : '登记更换'}
        width={620}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="installId" label="发生更换的安装位" rules={[{ required: true, message: '请选择安装位' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              disabled={!!editingId}
              options={installs.map((install) => {
                const station = stations.find((row) => row.id === install.stationId);
                return {
                  label: `${station?.code ?? '未知台站'} · ${install.channel} · 当前 ${install.serialNo}`,
                  value: install.id,
                };
              })}
            />
          </Form.Item>
          <Form.Item name="reason" label="更换原因" rules={[{ required: true, message: '请填写更换原因' }]}>
            <Input.TextArea rows={2} maxLength={100} />
          </Form.Item>
          <Space wrap style={{ marginBottom: 12 }}>
            <span className="gb-hint">原因模板：</span>
            {REPLACE_REASON_TEMPLATES.map((template) => (
              <Button key={template.key} size="small" onClick={() => form.setFieldValue('reason', template.reason)}>
                {template.reason.slice(0, 10)}…
              </Button>
            ))}
          </Space>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="newSerialNo" label="新序列号（换机后落到该安装位）" rules={[{ required: true, message: '请填写新序列号' }]}>
                <Input maxLength={60} placeholder="如：CMG-3E-20250410-33" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="date" label="更换日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="state" label="状态" rules={[{ required: true }]}>
                <Select options={REPLACE_STATES.map((state) => ({ label: state, value: state }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="operator" label="责任人" rules={[{ required: true, message: '请填写责任人' }]}>
                <Input maxLength={20} placeholder="如：周渝" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={100} placeholder="如：新仪器已到货，待停电窗口安装" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
