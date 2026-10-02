/**
 * 路由表：
 * /arrays 台阵台账（运维）
 * /stations/:id/instruments 台站安装位（运维）
 * /devices 物理仪器台账（计量站）
 * /calibrations 标定记录台（计量站）
 * /replacements 合格评定与更换（两侧）
 * /claims 序列号对账与同步重试（两侧）
 * /geometry 台阵几何与备份
 */
import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import { Skeleton } from 'antd';
import App from '@/App';

const ArrayList = lazy(() => import('@/pages/ArrayList'));
const StationInstruments = lazy(() => import('@/pages/StationInstruments'));
const DeviceBoard = lazy(() => import('@/pages/DeviceBoard'));
const CalibrationBoard = lazy(() => import('@/pages/CalibrationBoard'));
const ReplaceBoard = lazy(() => import('@/pages/ReplaceBoard'));
const ReconcileBoard = lazy(() => import('@/pages/ReconcileBoard'));
const GeometryView = lazy(() => import('@/pages/GeometryView'));

/** 懒加载页面占位 */
function RouteFallback() {
  return (
    <Skeleton
      active
      paragraph={{ rows: 6 }}
      style={{ background: '#ffffff', padding: 16, borderRadius: 10 }}
    />
  );
}

/** 包裹懒加载页面，避免整页被 Suspense 卸载 */
function withSuspense(node: ReactNode): ReactNode {
  return <Suspense fallback={<RouteFallback />}>{node}</Suspense>;
}

export const ROUTES = {
  arrays: '/arrays',
  stations: (arrayId: string): string => `/stations/${arrayId}/instruments`,
  devices: '/devices',
  calibrations: '/calibrations',
  replacements: '/replacements',
  claims: '/claims',
  geometry: '/geometry',
} as const;

export const appRoutes: RouteObject[] = [
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Navigate to={ROUTES.arrays} replace /> },
      { path: 'arrays', element: withSuspense(<ArrayList />) },
      { path: 'stations/:id/instruments', element: withSuspense(<StationInstruments />) },
      { path: 'devices', element: withSuspense(<DeviceBoard />) },
      { path: 'calibrations', element: withSuspense(<CalibrationBoard />) },
      { path: 'replacements', element: withSuspense(<ReplaceBoard />) },
      { path: 'claims', element: withSuspense(<ReconcileBoard />) },
      { path: 'geometry', element: withSuspense(<GeometryView />) },
      { path: '*', element: <Navigate to={ROUTES.arrays} replace /> },
    ],
  },
];

export default appRoutes;
