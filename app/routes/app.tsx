import { NavLink, Outlet } from "react-router";

export default function AppLayout() {
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    isActive
      ? "text-sm font-medium text-gray-900 border-b-2 border-blue-600 pb-0.5"
      : "text-sm font-medium text-gray-500 hover:text-gray-800 transition-colors";

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-6 py-0 flex items-center justify-between h-14">
        <div className="flex items-center gap-8">
          <span className="text-base font-semibold text-gray-800 mr-2">Stocky</span>
          <NavLink to="/dashboard" className={linkClass}>Dashboard</NavLink>
          <NavLink to="/invoices" className={linkClass}>Purchase Orders</NavLink>
          <NavLink to="/vendors" className={linkClass}>Vendors</NavLink>
          <NavLink to="/credits" className={linkClass}>Credits</NavLink>
          <NavLink to="/users" className={linkClass}>Users</NavLink>
        </div>
        <form method="post" action="/logout">
          <button
            type="submit"
            className="text-sm text-gray-500 hover:text-gray-800 transition-colors"
          >
            Sign out
          </button>
        </form>
      </nav>
      <Outlet />
    </div>
  );
}
