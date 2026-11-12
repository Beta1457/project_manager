import { StrictMode, Suspense, lazy, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, onUnauthorized } from './api';
import { useMe } from './hooks';
import { ToastProvider } from './components/Toast';
import { Layout, MorePage } from './components/Layout';
import { Spinner } from './components/Bits';
import { ProjectProvider } from './project';
import { LoginPage, returnPath } from './pages/Login';
import { BoardPage } from './pages/Board';
import { ListPage } from './pages/List';
import { EpochDetailPage, EpochsPage } from './pages/Epochs';
import { ExplorerPage } from './pages/Explorer';
// The diagram editor pulls in React Flow (the largest dependency); load it only when opened.
const DiagramPage = lazy(() => import('./pages/Diagram').then((m) => ({ default: m.DiagramPage })));
import { TimePage } from './pages/Time';
import { SettingsPage } from './pages/Settings';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

function RequireAuth({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(
    () =>
      onUnauthorized(() => {
        queryClient.clear();
        // Session expired mid-use: come back to the same page after signing in again.
        navigate('/login', { replace: true, state: { from: window.location.pathname + window.location.search } });
      }),
    [navigate],
  );
  if (me.isLoading) return <Spinner />;
  if (me.isError) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

/** Already signed in (e.g. a bookmarked /login)? Skip the form. */
function LoginRoute() {
  const me = useMe();
  const location = useLocation();
  if (me.isLoading) return <Spinner />;
  if (me.isSuccess) return <Navigate to={returnPath(location.state)} replace />;
  return <LoginPage />;
}

/** Unknown paths go to the board but keep the query string, so "?task=12" links still open the task. */
function ToBoard() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: '/', search }} replace />;
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route element={<RequireAuth><ProjectProvider><Layout /></ProjectProvider></RequireAuth>}>
        <Route index element={<BoardPage />} />
        <Route path="list" element={<ListPage />} />
        <Route path="epochs" element={<EpochsPage />} />
        <Route path="epochs/:id" element={<EpochDetailPage />} />
        <Route path="explorer" element={<ExplorerPage />} />
        <Route path="diagram" element={<Suspense fallback={<Spinner />}><DiagramPage /></Suspense>} />
        <Route path="time" element={<TimePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="more" element={<MorePage />} />
        <Route path="*" element={<ToBoard />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
