/**
 * 计量站：/devices 物理仪器台账
 * 按序列号记每台物理仪器的型号、档案状态与合格到期日；
 * 历次标定跟着序列号走，可查看每台设备的完整标定历史（含换机前在别的安装位的记录）。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  App as AntdApp,
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
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import FilterBar from '@/components/common/FilterBar';
import type { FilterModel } from '@/types/filter';
import StatBadge from '@/components/common/StatBadge';
import QualifyTag from '@/components/common/QualifyTag';
import EmptyPanel from '@/components/common/EmptyPanel';
import { ROUTES } from '@/router';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectStations } from '@/stores/arraySlice';
import { selectInstalls } from '@/stores/installSlice';
import {
  createDevice,
  removeDevice,
  selectDevices,
  updateDevice,
} from '@/stores/deviceSlice';
import { selectCalibrations } from '@/stores/calibrationSlice';
import {
  COMMON_MODELS,
  DEVICE_STATES,
  INSTRUMENT_TYPES,
  type Device,
  type DeviceState,
  type InstrumentType,
} from '@/types/device';
import { initDatabase } from '@/utils/db';

interface DeviceFormValues {
  type: InstrumentType;
  model: string;
  serialNo: string;
  state: DeviceState;
  remark: string;
}

export default function DeviceBoard() {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const devices = useAppSelector(selectDevices);
  const installs = useAppSelector(selectInstalls);
  const stations = useAppSelector(selectStations);
  const calibrations = useAppSelector(selectCalibrations);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingIdId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [types, setTypes] = useState<string[]>([]);
  const [states, setStates] = useState<string[]>([]);
  const [historySerial, setHistorySerial] = useState<string | null>(null);
  const [form] = Form.useForm<DeviceFormValues>();

  useEffect(() => {
    if (devices.length === 0) void initDatabase();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const installBySerial = useMemo(
    () => new Map(installs.map((install) => [install.serialNo, install])),
    [installs]
  );
  const stationById = useMemo(
    () => new Map(stations.map((station) => [station.id, station])),
    [stations]
  );
  const calibsBySerial = useMemo(() => {
    const map = new Map<string, typeof calibrations>();
    calibrations.forEach((row) => {
      const list = map.get(row.serialNo) ?? [];
      list.push(row);
      map.set(row.serialNo, list);
    });
    map.forEach((list) => list.sort((a, b) => b.date.localeCompare(a.date)));
    return map;
  }, [calibrations]);

  const rows = useMemo(() => {
    const kw = keyword.trim();
    return devices
      .filter((device) => {
        if (kw.length > 0) {
          const install = installBySerial.get(device.serialNo);
          const station = install ? stationById.get(install.stationId) : undefined;
          const haystack = `${device.model}${device.serialNo}${device.remark}${station?.code ?? ''}`;
          if (!haystack.includes(kw)) return false;
        }
        if (types.length > 0 && !types.includes(device.type)) return false;
        if (states.length > 0 && !states.includes(device.state)) return false;
        return true;
      })
      .sort((a, b) => a.serialNo.localeCompare(b.serialNo));
  }, [devices, installBySerial, keyword, stationById, states, types]);

  const totals = useMemo(() => {
    const overdue = rows.filter((device) => {
      if (!device.qualifyDueDate) return false;
      return Date.parse(`${device.qualifyDueDate}T00:00:00`) < Date.now();
    }).length;
    const noDue = rows.filter((device) => !device.qualifyDueDate).length;
    const installed = rows.filter((device) => installBySerial.has(device.serialNo)).length;
    return { total: rows.length, overdue, noDue, installed };
  }, [installBySerial, rows]);

  const filterModel: FilterModel = { keyword, types, states };

  const openCreate = () => {
    setEditingIdId(null);
    form.setFieldsValue({
      type: '宽频带',
      model: COMMON_MODELS.宽频带[0],
      serialNo: '',
      state: '在用',
      remark: '',
    });
    setModalOpen(true);
  };

  const openEdit = (device: Device) => {
    setEditingIdId(device.id);
    form.setFieldsValue({
      type: device.type,
      model: device.model,
      serialNo: device.serialNo,
      state: device.state,
      remark: device.remark,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      const payload = {
        type: values.type,
        model: values.model.trim(),
        serialNo: values.serialNo.trim(),
        state: values.state,
        remark: values.remark?.trim() ?? '',
      };
      if (editingId) {
        await dispatch(updateDevice({ id: editingId, patch: payload })).unwrap();
        message.success('物理仪器档案已更新');
      } else {
        await dispatch(createDevice(payload)).unwrap();
        message.success('物理仪器已建档，对应序列号挂账（若有）已自动认领');
      }
      setModalOpen(false);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '物理仪器保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  const historyDevice = historySerial ? devices.find((d) => d.serialNo === historySerial) ?? null : null;
  const historyRows = historySerial ? calibsBySerial.get(historySerial) ?? [] : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            物理仪器台账（计量站）
          </Typography.Title>
          <p className="gb-hint">
            按序列号管理每台物理仪器的型号与合格到期日；历次标定跟着序列号走，换机不带走、不串台。
          </p>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void initDatabase()}>
            补齐演示数据
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建物理仪器档案
          </Button>
        </Space>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="物理仪器" value={totals.total} suffix="台" tone="primary" />
        <StatBadge label="当前在装" value={totals.installed} suffix="台" tone="info" />
        <StatBadge
          label="合格已到期"
          value={totals.overdue}
          suffix="台"
          tone={totals.overdue > 0 ? 'danger' : 'success'}
        />
        <StatBadge
          label="从未合格标定"
          value={totals.noDue}
          suffix="台"
          tone={totals.noDue > 0 ? 'warning' : 'success'}
        />
      </div>

      <FilterBar
        modelValue={filterModel}
        selects={[
          {
            key: 'types',
            label: '仪器类型',
            options: INSTRUMENT_TYPES.map((type) => ({ label: type, value: type })),
          },
          {
            key: 'states',
            label: '档案状态',
            options: DEVICE_STATES.map((state) => ({ label: state, value: state })),
          },
        ]}
        keywordPlaceholder="搜索型号 / 序列号 / 台站 / 备注"
        onChange={(next) => {
          setKeyword(next.keyword);
          setTypes((next.types as string[]) ?? []);
          setStates((next.states as string[]) ?? []);
        }}
        onReset={() => {
          setKeyword('');
          setTypes([]);
          setStates([]);
        }}
        extra={
          <Button size="small" onClick={() => navigate(ROUTES.claims)}>
            去处理待认领序列号
          </Button>
        }
      />

      {rows.length === 0 ? (
        <EmptyPanel
          title={devices.length === 0 ? '还没有物理仪器档案' : '没有符合条件的仪器'}
          description="计量站按序列号建档；运维侧安装位填了但计量站没有的序列号，会出现在「序列号对账」里待认领。"
          actionText="新建物理仪器档案"
          secondaryText="去序列号对账"
          onAction={openCreate}
          onSecondary={() => navigate(ROUTES.claims)}
        />
      ) : (
        <Table
          rowKey="id"
          className="gb-table-compact"
          dataSource={rows}
          pagination={{ pageSize: 12, showSizeChanger: false }}
          columns={[
            {
              title: '序列号',
              dataIndex: 'serialNo',
              width: 220,
              render: (value: string) => <span className="gb-mono">{value}</span>,
            },
            {
              title: '型号 / 类型',
              width: 200,
              render: (_: unknown, device: Device) => (
                <div>
                  <div>{device.model || '未填型号'}</div>
                  <Tag>{device.type}</Tag>
                </div>
              ),
            },
            {
              title: '当前位置',
              width: 180,
              render: (_: unknown, device: Device) => {
                const install = installBySerial.get(device.serialNo);
                const station = install ? stationById.get(install.stationId) : undefined;
                return install ? (
                  <div>
                    <div className="gb-mono">{station?.code ?? '未知台站'} · {install.channel}</div>
                    <div className="gb-hint">装机 {install.installDate}</div>
                  </div>
                ) : (
                  <Tag>{device.state === '库存' ? '库存 / 未安装' : '已拆下 / 停用'}</Tag>
                );
              },
            },
            {
              title: '合格到期日',
              dataIndex: 'qualifyDueDate',
              width: 140,
              className: 'gb-mono',
              render: (value: string | null) => {
                if (!value) return <span className="gb-hint">未标定</span>;
                const overdue = Date.parse(`${value}T00:00:00`) < Date.now();
                return <span className={overdue ? 'gb-danger' : ''}>{value}</span>;
              },
            },
            {
              title: '档案状态',
              dataIndex: 'state',
              width: 100,
              render: (value: DeviceState) => (
                <Tag color={value === '在用' ? 'green' : value === '库存' ? 'blue' : 'default'}>{value}</Tag>
              ),
            },
            {
              title: '历次标定',
              width: 180,
              render: (_: unknown, device: Device) => {
                const list = calibsBySerial.get(device.serialNo) ?? [];
                const latest = list[0];
                if (!latest) return <span className="gb-hint">尚无标定</span>;
                return (
                  <div>
                    <QualifyTag verdict={latest.responseVerdict} size="small" />
                    <div className="gb-hint">共 {list.length} 次 · 最近 {latest.date}</div>
                  </div>
                );
              },
            },
            { title: '备注', dataIndex: 'remark', ellipsis: true },
            {
              title: '操作',
              width: 210,
              render: (_: unknown, device: Device) => (
                <Space size={6}>
                  <Button size="small" onClick={() => setHistorySerial(device.serialNo)}>
                    标定历史
                  </Button>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(device)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除物理仪器"
                    description="其历次标定将一并删除；引用该序列号的安装位会转为挂账待核对，确认？"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() =>
                      void dispatch(removeDevice(device.id))
                        .unwrap()
                        .then(() => message.success('物理仪器及其标定已删除，相关安装位已转挂账'))
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

      <Card className="gb-panel" size="small" title="序列号历次标定（换机前后完整历史）">
        {!historySerial ? (
          <EmptyPanel title="选择一台物理仪器" description="在上表点击「标定历史」，查看该序列号的全部标定记录。" compact />
        ) : (
          <Table
            rowKey="id"
            size="small"
            className="gb-table-compact"
            dataSource={historyRows}
            pagination={false}
            locale={{ emptyText: <EmptyPanel title="该序列号尚无标定" compact /> }}
            columns={[
              { title: '序列号', width: 200, render: () => <span className="gb-mono">{historySerial}</span> },
              { title: '标定日期', dataIndex: 'date', width: 120, className: 'gb-mono' },
              { title: '灵敏度', dataIndex: 'sensitivity', width: 110, align: 'right', className: 'gb-mono' },
              { title: '自噪', dataIndex: 'selfNoise', width: 90, align: 'right', className: 'gb-mono' },
              {
                title: '结论',
                dataIndex: 'responseVerdict',
                width: 120,
                render: (verdict) => <QualifyTag verdict={verdict} size="small" />,
              },
              { title: '标定人', dataIndex: 'operator', width: 100 },
              { title: '机构', dataIndex: 'agency', width: 160 },
              { title: '备注', dataIndex: 'remark', ellipsis: true },
            ]}
          />
        )}
        {historyDevice ? (
          <p className="gb-hint" style={{ marginTop: 8 }}>
            {historyDevice.model}（{historyDevice.serialNo}）合格到期日：
            {historyDevice.qualifyDueDate ?? '尚无合格标定'}。该历史在换机后仍完整保留在本序列号下。
          </p>
        ) : null}
      </Card>

      <Modal
        open={modalOpen}
        title={editingId ? '编辑物理仪器档案' : '新建物理仪器档案'}
        onCancel={() => setModalOpen(false)}
        onOk={() => void submit()}
        confirmLoading={submitting}
        okText={editingId ? '保存修改' : '建档并认领挂账'}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="type" label="仪器类型" rules={[{ required: true }]}>
            <Select
              options={INSTRUMENT_TYPES.map((type) => ({ label: type, value: type }))}
              onChange={(value: InstrumentType) =>
                form.setFieldValue('model', COMMON_MODELS[value]?.[0] ?? '')
              }
            />
          </Form.Item>
          <Form.Item name="model" label="型号" rules={[{ required: true, message: '请填写型号' }]}>
            <Input placeholder="如：CMG-3ESPC" maxLength={40} />
          </Form.Item>
          <Form.Item
            name="serialNo"
            label="序列号（全局唯一，建档即认领）"
            rules={[{ required: true, message: '请填写序列号' }]}
          >
            <Input placeholder="如：CMG-3E-20210418-01" maxLength={60} disabled={!!editingId} />
          </Form.Item>
          <Form.Item name="state" label="档案状态" rules={[{ required: true }]}>
            <Select options={DEVICE_STATES.map((state) => ({ label: state, value: state }))} />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
