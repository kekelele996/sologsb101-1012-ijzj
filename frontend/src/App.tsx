/**
 * 应用外壳：侧边导航 + 顶部上下文条 + 内容区 + 页脚。
 * 导航按两份台账分组：运维班组（台阵/安装位/更换）与计量站（物理仪器/标定/对账）。
 */
import { useEffect } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Badge, Button, Layout, Menu, Space, Tag, Typography, message } from 'antd';
import {
  AppstoreOutlined,
  DashboardOutlined,
  ExperimentOutlined,
  GlobalOutlined,
  SwapOutlined,
  ThunderboltOutlined,
  SafetyCertificateOutlined,
  LinkOutlined,
} from '@ant-design/icons';
import { ROUTES } from '@/router';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import {
  selectArrays,
  selectCurrentArrayId,
  selectStations,
  startArraySubscription,
} from '@/stores/arraySlice';
import { selectInstalls, startInstallSubscription } from '@/stores/installSlice';
import { selectDevices, startDeviceSubscription } from '@/stores/deviceSlice';
import {
  selectCalibrations,
  selectFailedEventCount,
  selectPendingClaimCount,
  selectReplaces,
  startCalibrationSubscription,
} from '@/stores/calibrationSlice';
import { DB_NAME, DB_VERSION, initDatabase } from '@/utils/db';

const { Header, Sider, Content, Footer } = Layout;

/** 按当前路径决定导航高亮项 */
function buildSelectedKey(pathname: string, currentArrayId: string | null): string {
  if (pathname.startsWith('/calibrations')) return ROUTES.calibrations;
  if (pathname.startsWith('/devices')) return ROUTES.devices;
  if (pathname.startsWith('/claims')) return ROUTES.claims;
  if (pathname.startsWith('/replacements')) return ROUTES.replacements;
  if (pathname.startsWith('/geometry')) return ROUTES.geometry;
  if (pathname.startsWith('/stations/') && currentArrayId) return ROUTES.stations(currentArrayId);
  return ROUTES.arrays;
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const [messageApi, contextHolder] = message.useMessage();

  const arrays = useAppSelector(selectArrays);
  const stations = useAppSelector(selectStations);
  const installs = useAppSelector(selectInstalls);
  const devices = useAppSelector(selectDevices);
  const calibrations = useAppSelector(selectCalibrations);
  const replaces = useAppSelector(selectReplaces);
  const pendingClaims = useAppSelector(selectPendingClaimCount);
  const failedEvents = useAppSelector(selectFailedEventCount);
  const currentArrayId = useAppSelector(selectCurrentArrayId);
  const ready = useAppSelector((state) => state.array.ready);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await initDatabase();
        if (cancelled) return;
        // 打开数据库后启动各表实时订阅，数据自动回流到 Redux
        startArraySubscription(dispatch);
        startInstallSubscription(dispatch);
        startDeviceSubscription(dispatch);
        startCalibrationSubscription(dispatch);
      } catch (error) {
        if (cancelled) return;
        messageApi.error(
          `本地数据库初始化失败：${error instanceof Error ? error.message : '未知错误'}`
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dispatch, messageApi]);

  const currentArray = arrays.find((row) => row.id === currentArrayId) ?? null;
  const selectedKey = buildSelectedKey(location.pathname, currentArrayId);
  const unqualified = calibrations.filter((row) => row.responseVerdict === '不合格').length;
  const pendingReplaces = replaces.filter((row) => row.state !== '已复核').length;

  return (
    <>
      {contextHolder}
      <Layout style={{ minHeight: '100vh', background: 'var(--gb-paper)' }}>
        <Sider
          width={248}
          breakpoint="lg"
          collapsedWidth={0}
          style={{ background: '#16283f', borderRight: '3px solid #1e3a5f' }}
        >
          <div style={{ padding: '18px 16px 10px' }}>
            <Typography.Title level={5} style={{ color: '#e8f1fb', margin: 0 }}>
              地震台阵仪器标定台账
            </Typography.Title>
            <Typography.Text style={{ color: 'rgba(232,241,251,0.62)', fontSize: 12 }}>
              gbseisarray · 运维 / 计量 两份台账
            </Typography.Text>
          </div>
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={[selectedKey]}
            style={{ background: 'transparent' }}
            onClick={({ key }) => navigate(key)}
            items={[
              { key: 'g_ops', type: 'group', label: '运维班组 · 安装位台账' },
              { key: ROUTES.arrays, icon: <AppstoreOutlined />, label: '台阵与台站台账' },
              {
                key: currentArrayId ? ROUTES.stations(currentArrayId) : 'stations-disabled',
                icon: <ExperimentOutlined />,
                label: currentArray ? `台站安装位 · ${currentArray.name}` : '台站安装位（先选台阵）',
                disabled: !currentArrayId,
              },
              { key: ROUTES.replacements, icon: <SwapOutlined />, label: '合格评定与更换' },
              { key: 'g_metro', type: 'group', label: '计量站 · 物理仪器台账' },
              { key: ROUTES.devices, icon: <SafetyCertificateOutlined />, label: '物理仪器档案' },
              { key: ROUTES.calibrations, icon: <DashboardOutlined />, label: '标定记录台' },
              {
                key: ROUTES.claims,
                icon: <LinkOutlined />,
                label: (
                  <Badge count={pendingClaims + failedEvents} size="small" offset={[10, 0]}>
                    序列号对账
                  </Badge>
                ),
              },
              { key: 'g_sys', type: 'group', label: '系统' },
              { key: ROUTES.geometry, icon: <GlobalOutlined />, label: '台阵几何与备份' },
            ]}
          />
          <div style={{ padding: '12px 16px', color: 'rgba(232,241,251,0.62)', fontSize: 12 }}>
            <Space direction="vertical" size={2}>
              <span>
                <AppstoreOutlined /> 台阵 {arrays.length} · 台站 {stations.length}
              </span>
              <span>
                <ExperimentOutlined /> 安装位 {installs.length}
              </span>
              <span>
                <SafetyCertificateOutlined /> 物理仪器 {devices.length}
              </span>
              <span>
                <ThunderboltOutlined /> 标定 {calibrations.length} · 不合格 {unqualified}
              </span>
              <span>
                <LinkOutlined /> 待认领 {pendingClaims} · 同步失败 {failedEvents}
              </span>
              <span>
                <SwapOutlined /> 更换未闭环 {pendingReplaces}
              </span>
            </Space>
          </div>
        </Sider>

        <Layout style={{ background: 'var(--gb-paper)' }}>
          <Header
            style={{
              background: '#ffffff',
              borderBottom: '1px solid var(--gb-line)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingInline: 20,
              gap: 12,
              flexWrap: 'wrap',
              height: 'auto',
              lineHeight: 'normal',
              paddingBlock: 10,
            }}
          >
            <Space size={10} wrap>
              <Typography.Text strong>当前台阵：</Typography.Text>
              {currentArray ? (
                <>
                  <Tag color="#1e3a5f">{currentArray.name}</Tag>
                  <Tag>孔径 {currentArray.apertureKm} km</Tag>
                  <Tag color={currentArray.state === '运行中' ? 'green' : 'orange'}>{currentArray.state}</Tag>
                  <Tag>布设 {currentArray.deployDate}</Tag>
                </>
              ) : (
                <Tag>未选择台阵</Tag>
              )}
            </Space>
            <Space>
              <Badge count={pendingClaims} showZero color="#d68910" title="待认领序列号" />
              <Badge count={failedEvents} showZero color="#c0392b" title="同步失败事件" />
              <Badge count={calibrations.length} showZero color="#3f7bbf" title="标定记录总数" />
              {currentArrayId ? (
                <Button size="small" onClick={() => navigate(ROUTES.stations(currentArrayId))}>
                  台站安装位
                </Button>
              ) : null}
              <Button size="small" type="primary" onClick={() => navigate(ROUTES.arrays)}>
                台阵台账
              </Button>
            </Space>
          </Header>

          <Content style={{ padding: 20, minHeight: 360 }}>
            {!ready ? (
              <div className="gb-panel gb-hint">正在打开本地数据库（IndexedDB）并载入数据…</div>
            ) : null}
            <Outlet />
          </Content>

          <Footer style={{ textAlign: 'center', background: 'transparent', color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>
            本地库 {DB_NAME} · 结构版本 v{DB_VERSION} · 运维按安装位、计量按序列号各维护一份 · 数据仅存本机浏览器
            （IndexedDB），不上传任何服务器 ·
            <Link to={ROUTES.arrays} style={{ marginLeft: 6 }}>
              返回台阵台账
            </Link>
          </Footer>
        </Layout>
      </Layout>
    </>
  );
}
