/**
 * 序列号对账（两侧协作）：
 * - 运维侧安装位 / 计量侧标定里对不上的序列号先挂账，写清台站；
 * - 计量站认过（补建物理仪器档案）才算数，认过不退回；
 * - 同步失败后各按本侧重试（只重试自己发出的事件）。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  ReloadOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import {
  retrySideEvents,
  runClaimsReconciliation,
  selectClaimCounts,
  selectClaims,
  selectOutbox,
} from '@/stores/calibrationSlice';
import { selectDevices } from '@/stores/deviceSlice';
import { acknowledgeClaim, rejectClaim, retryEvent } from '@/utils/sync';
import {
  COMMON_MODELS,
  INSTRUMENT_TYPES,
  type InstrumentType,
} from '@/types/device';
import { CLAIM_SOURCES, type ClaimState, type SerialClaim } from '@/types/claim';
import {
  SYNC_KIND_LABEL,
  SYNC_SIDE_LABEL,
  SYNC_STATUS_LABEL,
  type SyncEvent,
  type SyncSide,
} from '@/types/sync';
import { initDatabase } from '@/utils/db';

interface AcknowledgeFormValues {
  type: InstrumentType;
  model: string;
  serialNo: string;
  resolveNote: string;
}

const STATE_COLOR: Record<ClaimState, string> = {
  待认领: 'orange',
  已认领: 'green',
  已驳回: 'default',
};

export default function ReconcileBoard() {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const claims = useAppSelector(selectClaims);
  const outbox = useAppSelector(selectOutbox);
  const devices = useAppSelector(selectDevices);
  const claimCounts = useAppSelector(selectClaimCounts);

  const [stateFilter, setStateFilter] = useState<ClaimState[]>(['待认领']);
  const [keyword, setKeyword] = useState('');
  const [ackClaim, setAckClaim] = useState<SerialClaim | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<AcknowledgeFormValues>();

  useEffect(() => {
    void initDatabase();
  }, []);

  const deviceSerials = useMemo(() => new Set(devices.map((device) => device.serialNo)), [devices]);

  const claimRows = useMemo(() => {
    const kw = keyword.trim();
    return claims
      .filter((claim) => {
        if (stateFilter.length > 0 && !stateFilter.includes(claim.state)) return false;
        if (kw.length > 0) {
          const haystack = `${claim.serialNo}${claim.stationCode}${claim.arrayName}${claim.note}${claim.resolveNote}`;
          if (!haystack.includes(kw)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const order: Record<ClaimState, number> = { 待认领: 0, 已驳回: 1, 已认领: 2 };
        if (order[a.state] !== order[b.state]) return order[a.state] - order[b.state];
        return b.updatedAt - a.updatedAt;
      });
  }, [claims, keyword, stateFilter]);

  const failedBySide = useMemo(() => {
    const result: Record<SyncSide, number> = { ops: 0, metro: 0 };
    outbox.forEach((event) => {
      if (event.status === 'failed') result[event.side] += 1;
    });
    return result;
  }, [outbox]);

  const openAcknowledge = (claim: SerialClaim) => {
    setAckClaim(claim);
    const knownType: InstrumentType = '宽频带';
    form.setFieldsValue({
      type: knownType,
      model: COMMON_MODELS[knownType][0],
      serialNo: claim.serialNo,
      resolveNote: '现场核对设备铭牌无误，补建物理仪器档案',
    });
  };

  const submitAcknowledge = async () => {
    if (!ackClaim) return;
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await acknowledgeClaim(ackClaim.id, {
        type: values.type,
        model: values.model.trim(),
        serialNo: values.serialNo.trim(),
        resolveNote: values.resolveNote.trim(),
      });
      message.success(`序列号「${values.serialNo.trim()}」已认领并建档，运维侧可见（认过不退回）`);
      setAckClaim(null);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '认领失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async (claim: SerialClaim) => {
    try {
      await rejectClaim(claim.id, '计量站核对序列号有误，已驳回，请运维现场复核后重新登记');
      message.success('已驳回（认过不退回，需重新登记才会再挂账）');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '驳回失败');
    }
  };

  const handleReconcile = async () => {
    const result = await dispatch(runClaimsReconciliation()).unwrap();
    message.success(`对账完成：新增挂账 ${result.created} 条，自动认领 ${result.resolved} 条`);
  };

  const handleRetrySide = async (side: SyncSide) => {
    const result = await dispatch(retrySideEvents(side)).unwrap();
    message.success(`${SYNC_SIDE_LABEL[side]}重试完成，重新投递 ${result.count} 条事件`);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            序列号对账与两侧同步
          </Typography.Title>
          <p className="gb-hint">
            运维按安装位、计量按序列号各维护一份；对不上的序列号先挂账并写清台站，计量站认过才算数。
            同步失败后各按本侧重试，认过的结果不退回。
          </p>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void initDatabase()}>
            补齐演示数据
          </Button>
          <Button type="primary" icon={<SyncOutlined />} onClick={() => void handleReconcile()}>
            立即重新对账
          </Button>
        </Space>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="待认领" value={claimCounts.待认领} suffix="条" tone={claimCounts.待认领 > 0 ? 'warning' : 'success'} />
        <StatBadge label="已认领" value={claimCounts.已认领} suffix="条" tone="info" />
        <StatBadge label="已驳回" value={claimCounts.已驳回} suffix="条" tone="default" />
        <StatBadge label="运维侧待重试" value={failedBySide.ops} suffix="条" tone={failedBySide.ops > 0 ? 'danger' : 'success'} />
        <StatBadge label="计量侧待重试" value={failedBySide.metro} suffix="条" tone={failedBySide.metro > 0 ? 'danger' : 'success'} />
      </div>

      {claimCounts.待认领 > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`有 ${claimCounts.待认领} 个序列号在两侧台账间对不上，待计量站认领`}
          description="挂账已写清台站与安装位；计量站核对铭牌补建物理仪器档案后，安装位即生效。"
        />
      ) : (
        <Alert type="success" showIcon message="两侧序列号已全部对齐，没有待认领记录" />
      )}

      <Card
        className="gb-panel"
        size="small"
        title={`序列号挂账（${claimRows.length} 条）`}
        extra={
          <Space>
            <Input.Search
              allowClear
              placeholder="搜索序列号 / 台站"
              style={{ width: 220 }}
              onSearch={setKeyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Select
              mode="multiple"
              style={{ minWidth: 180 }}
              value={stateFilter}
              onChange={(value) => setStateFilter(value as ClaimState[])}
              options={(Object.keys(STATE_COLOR) as ClaimState[]).map((state) => ({ label: state, value: state }))}
            />
          </Space>
        }
      >
        {claimRows.length === 0 ? (
          <EmptyPanel
            title="当前筛选下没有挂账"
            description="运维登记了计量站尚无档案的序列号、或标定序列号无档案时，会自动挂账到这里。"
            actionText="立即重新对账"
            onAction={() => void handleReconcile()}
            compact
          />
        ) : (
          <Table
            rowKey="id"
            size="small"
            className="gb-table-compact"
            dataSource={claimRows}
            pagination={false}
            columns={[
              {
                title: '序列号',
                dataIndex: 'serialNo',
                width: 210,
                render: (value: string, claim: SerialClaim) => (
                  <div>
                    <span className="gb-mono">{value}</span>
                    {deviceSerials.has(claim.serialNo) ? (
                      <div className="gb-hint">档案已存在</div>
                    ) : null}
                  </div>
                ),
              },
              {
                title: '来源',
                dataIndex: 'source',
                width: 100,
                render: (value: string) => <Tag>{value}</Tag>,
              },
              {
                title: '台站（写清出处）',
                width: 220,
                render: (_: unknown, claim: SerialClaim) => (
                  <div>
                    <div className="gb-mono">{claim.stationCode}</div>
                    <div className="gb-hint">
                      {claim.arrayName}
                      {CLAIM_SOURCES.includes(claim.source) && claim.installId ? ` · 安装位 ${claim.installId.slice(-6)}` : ''}
                    </div>
                  </div>
                ),
              },
              { title: '挂账说明', dataIndex: 'note', ellipsis: true },
              {
                title: '状态',
                dataIndex: 'state',
                width: 100,
                render: (value: ClaimState) => <Tag color={STATE_COLOR[value]}>{value}</Tag>,
              },
              { title: '认领说明', dataIndex: 'resolveNote', ellipsis: true },
              {
                title: '操作',
                width: 200,
                render: (_: unknown, claim: SerialClaim) =>
                  claim.state === '待认领' ? (
                    <Space size={6}>
                      <Button size="small" type="primary" icon={<CheckCircleFilled />} onClick={() => openAcknowledge(claim)}>
                        认领建档
                      </Button>
                      <Popconfirm
                        title="驳回该序列号？"
                        description="驳回后认过不退回，需运维重新登记才会再次挂账。"
                        okText="驳回"
                        cancelText="取消"
                        onConfirm={() => void handleReject(claim)}
                      >
                        <Button size="small" danger icon={<CloseCircleFilled />}>
                          驳回
                        </Button>
                      </Popconfirm>
                    </Space>
                  ) : (
                    <span className="gb-hint">已处理，不退回</span>
                  ),
              },
            ]}
          />
        )}
      </Card>

      <Card
        className="gb-panel"
        size="small"
        title="两侧同步事件（失败后各按本侧重试）"
        extra={
          <Space>
            <Button size="small" onClick={() => void handleRetrySide('ops')}>
              运维侧重试（{failedBySide.ops}）
            </Button>
            <Button size="small" onClick={() => void handleRetrySide('metro')}>
              计量侧重试（{failedBySide.metro}）
            </Button>
          </Space>
        }
      >
        {outbox.length === 0 ? (
          <EmptyPanel title="暂无同步事件" description="两侧序列号一致时不会产生事件；换机、认领、标定都会产生对应事件。" compact />
        ) : (
          <Table
            rowKey="id"
            size="small"
            className="gb-table-compact"
            dataSource={[...outbox].sort((a, b) => b.updatedAt - a.updatedAt)}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            columns={[
              {
                title: '发起侧',
                dataIndex: 'side',
                width: 110,
                render: (side: SyncSide) => <Tag color={side === 'ops' ? 'blue' : 'purple'}>{SYNC_SIDE_LABEL[side]}</Tag>,
              },
              { title: '事件', dataIndex: 'kind', width: 150, render: (kind: SyncEvent['kind']) => SYNC_KIND_LABEL[kind] },
              { title: '序列号', dataIndex: 'serialNo', width: 200, render: (value: string) => <span className="gb-mono">{value}</span> },
              {
                title: '状态',
                dataIndex: 'status',
                width: 110,
                render: (status: SyncEvent['status']) => (
                  <Tag color={status === 'synced' ? 'green' : status === 'failed' ? 'red' : 'orange'}>
                    {SYNC_STATUS_LABEL[status]}
                  </Tag>
                ),
              },
              { title: '尝试次数', dataIndex: 'attempts', width: 90, align: 'right', className: 'gb-mono' },
              {
                title: '认过',
                dataIndex: 'acknowledged',
                width: 80,
                render: (value: boolean) => (value ? <Tag color="green">不退回</Tag> : <span className="gb-hint">—</span>),
              },
              { title: '最近失败原因', dataIndex: 'lastError', ellipsis: true, render: (value: string) => value || '—' },
              {
                title: '操作',
                width: 110,
                render: (_: unknown, event: SyncEvent) =>
                  event.status === 'failed' ? (
                    <Button
                      size="small"
                      onClick={async () => {
                        await retryEvent(event.id);
                        message.success('已按该侧重试');
                      }}
                    >
                      重试
                    </Button>
                  ) : (
                    <span className="gb-hint">—</span>
                  ),
              },
            ]}
          />
        )}
      </Card>

      <Modal
        open={!!ackClaim}
        title="计量站认领序列号并补建档案"
        onCancel={() => setAckClaim(null)}
        onOk={() => void submitAcknowledge()}
        confirmLoading={submitting}
        okText="认过并建档（不退回）"
        destroyOnClose
      >
        {ackClaim ? (
          <div className="gb-hint" style={{ marginBottom: 12 }}>
            来源：{ackClaim.source} · 台站 {ackClaim.stationCode}（{ackClaim.arrayName}）。认过后安装位即生效，结果不退回。
          </div>
        ) : null}
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="type" label="仪器类型" rules={[{ required: true }]}>
            <Select
              options={INSTRUMENT_TYPES.map((type) => ({ label: type, value: type }))}
              onChange={(value: InstrumentType) => form.setFieldValue('model', COMMON_MODELS[value]?.[0] ?? '')}
            />
          </Form.Item>
          <Form.Item name="model" label="型号" rules={[{ required: true, message: '请填写型号' }]}>
            <Input maxLength={40} />
          </Form.Item>
          <Form.Item
            name="serialNo"
            label="序列号（默认取挂账值，可更正为铭牌值）"
            rules={[{ required: true, message: '请填写序列号' }]}
          >
            <Input maxLength={60} />
          </Form.Item>
          <Form.Item name="resolveNote" label="认领说明">
            <Input.TextArea rows={2} maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
