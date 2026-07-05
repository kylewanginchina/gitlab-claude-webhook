import { useState } from 'react';
import AuthGate from './components/AuthGate';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';

export type AdminPage = 'dashboard' | 'settings';

export default function App() {
  const [page, setPage] = useState<AdminPage>('dashboard');

  return (
    <AuthGate>
      <Layout page={page} onPageChange={setPage}>
        {page === 'dashboard' ? <Dashboard /> : <Settings />}
      </Layout>
    </AuthGate>
  );
}
