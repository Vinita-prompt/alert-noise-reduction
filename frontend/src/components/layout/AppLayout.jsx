import { Outlet } from 'react-router-dom';
import Header from './Header.jsx';
import Sidebar from './Sidebar.jsx';

export default function AppLayout() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <Sidebar />
      <div className="lg:pl-72">
        <Header />
        <main className="px-4 py-6 md:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
