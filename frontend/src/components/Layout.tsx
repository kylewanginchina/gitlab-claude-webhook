import { PropsWithChildren } from 'react';
import { Activity, LayoutDashboard, Settings } from 'lucide-react';
import type { AdminPage } from '../App';

interface LayoutProps extends PropsWithChildren {
  page: AdminPage;
  onPageChange: (page: AdminPage) => void;
}

export default function Layout({ page, onPageChange, children }: LayoutProps) {
  return (
    <div className="admin-shell">
      <aside className="sidebar">
        <div className="brand">
          <strong>GitLab Claude Webhook</strong>
          <span>Admin console</span>
        </div>
        <nav className="nav-list" aria-label="Admin sections">
          <button
            className={`nav-button ${page === 'dashboard' ? 'active' : ''}`}
            onClick={() => onPageChange('dashboard')}
            type="button"
          >
            <LayoutDashboard size={18} />
            Dashboard
          </button>
          <button
            className={`nav-button ${page === 'settings' ? 'active' : ''}`}
            onClick={() => onPageChange('settings')}
            type="button"
          >
            <Settings size={18} />
            Runtime Settings
          </button>
        </nav>
        <div className="sidebar-note">
          <div className="split-title">
            <Activity size={14} />
            <strong>Runtime behavior</strong>
          </div>
          <p className="section-note">Hot-applied fields affect new tasks immediately. Restart-only fields are called out in place.</p>
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
