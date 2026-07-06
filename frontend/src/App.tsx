import { useState } from 'react';
import AuthGate from './components/AuthGate';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import ReviewTuning from './pages/ReviewTuning';
import Settings from './pages/Settings';

export type AdminPage = 'dashboard' | 'settings' | 'review-tuning';

export default function App() {
  const [page, setPage] = useState<AdminPage>('dashboard');

  return (
    <AuthGate>
      <Layout page={page} onPageChange={setPage}>
        {page === 'dashboard' ? <Dashboard /> : page === 'settings' ? <Settings /> : <ReviewTuning />}
      </Layout>
    </AuthGate>
  );
}
