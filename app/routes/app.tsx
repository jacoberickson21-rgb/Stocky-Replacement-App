import { NavLink, Outlet } from "react-router";
import type { Route } from "./+types/app";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const result = await getDb().$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*) as count FROM "FailureLog" WHERE "resolvedAt" IS NULL
  `;
  return { unresolvedFailures: Number(result[0]?.count ?? 0) };
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const { unresolvedFailures } = loaderData;

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
          <NavLink to="/suppliers" className={linkClass}>Suppliers</NavLink>
          <NavLink to="/vendors" className={linkClass}>Vendors</NavLink>
          <NavLink to="/credits" className={linkClass}>Credits</NavLink>
          <NavLink to="/users" className={linkClass}>Users</NavLink>
          <NavLink to="/failures" className={({ isActive }) =>
            `relative flex items-center gap-1.5 ${linkClass({ isActive })}`
          }>
            Failures
            {unresolvedFailures > 0 && (
              <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-xs font-bold leading-none">
                {unresolvedFailures > 99 ? "99+" : unresolvedFailures}
              </span>
            )}
          </NavLink>
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
