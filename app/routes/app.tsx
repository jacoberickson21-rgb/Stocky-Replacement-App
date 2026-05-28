import { NavLink, Outlet, useFetcher } from "react-router";
import { useState, useEffect, useRef } from "react";
import type { Route } from "./+types/app";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";
import { getSyncStatus } from "../services/sync.server";
import type { SyncLogData } from "../services/sync.server";
import {
  LayoutDashboard,
  Package,
  ShoppingCart,
  Truck,
  Store,
  CreditCard,
  Users,
  AlertTriangle,
  ScrollText,
  BarChart2,
  Settings,
  RefreshCw,
  Sun,
  Moon,
  LogOut,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const [failureResult, syncStatus] = await Promise.all([
    getDb().$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) as count FROM "FailureLog" WHERE "resolvedAt" IS NULL
    `,
    getSyncStatus(),
  ]);
  return {
    unresolvedFailures: Number(failureResult[0]?.count ?? 0),
    syncStatus,
  };
}

function timeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function SyncButton({ initialStatus, collapsed }: { initialStatus: SyncLogData | null; collapsed: boolean }) {
  const [status, setStatus] = useState<SyncLogData | null>(initialStatus);
  const fetcher = useFetcher<SyncLogData>();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isRunning = status?.status === "RUNNING" || fetcher.state !== "idle";

  useEffect(() => {
    if (!isRunning) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = setInterval(() => {
      fetch("/api/sync")
        .then((r) => r.json())
        .then((data) => setStatus(data as SyncLogData))
        .catch(() => {});
    }, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [isRunning]);

  useEffect(() => {
    if (fetcher.data) setStatus(fetcher.data as SyncLogData);
  }, [fetcher.data]);

  function triggerSync() {
    fetcher.submit({}, { method: "POST", action: "/api/sync" });
  }

  const current = status?.currentVariant ?? 0;
  const total = status?.totalVariants;
  const progressLabel = total ? `${current} / ${total}` : current > 0 ? `${current}…` : "";

  const dotColor = isRunning
    ? "bg-blue-400 animate-pulse"
    : status?.status === "ERROR"
    ? "bg-red-500"
    : status?.status === "COMPLETE"
    ? "bg-green-500"
    : "bg-gray-600";

  if (collapsed) {
    const tooltip = isRunning
      ? `Syncing${progressLabel ? ` (${progressLabel})` : "…"}`
      : status?.status === "ERROR"
      ? "Sync failed — click to retry"
      : status?.completedAt
      ? `Synced ${timeAgo(status.completedAt)}`
      : "Sync Data";

    return (
      <div className="relative group mx-2">
        <button
          onClick={triggerSync}
          disabled={isRunning}
          className={[
            "relative flex items-center justify-center w-full py-2.5 px-3 rounded-lg transition-colors",
            isRunning ? "text-indigo-400 cursor-not-allowed" : "text-gray-400 hover:text-white hover:bg-white/5",
          ].join(" ")}
        >
          <RefreshCw size={18} className={isRunning ? "animate-spin" : ""} />
          <span className={`absolute top-2 right-2 w-2 h-2 rounded-full ${dotColor}`} />
        </button>
        <div className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-3 z-50 opacity-0 group-hover:opacity-100 transition-opacity duration-100">
          <div className="bg-gray-800 text-white text-xs font-medium px-2 py-1 rounded border border-gray-700 whitespace-nowrap shadow-lg">
            {tooltip}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5 px-2 mb-1">
      <button
        onClick={triggerSync}
        disabled={isRunning}
        className={[
          "flex items-center justify-center gap-1.5 w-full text-xs font-medium px-3 py-2 rounded-lg transition-colors",
          isRunning
            ? "bg-indigo-500/20 text-indigo-300 cursor-not-allowed"
            : "bg-indigo-500 hover:bg-indigo-400 text-white",
        ].join(" ")}
      >
        {isRunning && <RefreshCw size={12} className="animate-spin" />}
        {isRunning ? `Syncing${progressLabel ? ` ${progressLabel}` : "…"}` : "Sync Data"}
      </button>
      {!isRunning && status?.status === "COMPLETE" && status.completedAt && (
        <span className="text-[10px] text-gray-500 text-center leading-none mt-0.5">
          Synced {timeAgo(status.completedAt)}
        </span>
      )}
      {!isRunning && status?.status === "ERROR" && (
        <span
          className="text-[10px] text-red-500 text-center leading-none mt-0.5 cursor-help"
          title={status.errorMessage ?? "Unknown error"}
        >
          Last sync failed
        </span>
      )}
    </div>
  );
}

function SidebarLink({
  to,
  icon,
  label,
  badge,
  collapsed,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  badge?: number;
  collapsed: boolean;
}) {
  return (
    <div className="relative group">
      <NavLink
        to={to}
        className={({ isActive }) =>
          [
            "flex items-center gap-3 mx-2 px-3 py-2.5 rounded-lg transition-colors",
            isActive
              ? "bg-indigo-500/20 text-indigo-300"
              : "text-gray-400 hover:text-white hover:bg-white/5",
          ].join(" ")
        }
      >
        <span className="relative flex-none">
          {icon}
          {badge != null && badge > 0 && (
            <span className="absolute -top-1.5 -right-1.5 flex items-center justify-center min-w-[16px] h-4 px-0.5 rounded-full bg-red-500 text-white text-[9px] font-bold leading-none">
              {badge > 99 ? "99+" : badge}
            </span>
          )}
        </span>
        <span
          className={[
            "text-sm font-medium whitespace-nowrap overflow-hidden transition-[max-width,opacity] duration-200",
            collapsed ? "max-w-0 opacity-0" : "max-w-[160px] opacity-100",
          ].join(" ")}
        >
          {label}
        </span>
      </NavLink>
      {collapsed && (
        <div className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-3 z-50 opacity-0 group-hover:opacity-100 transition-opacity duration-100">
          <div className="bg-gray-800 text-white text-xs font-medium px-2 py-1 rounded border border-gray-700 whitespace-nowrap shadow-lg">
            {label}
            {badge != null && badge > 0 && (
              <span className="ml-1.5 text-red-400">({badge})</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SidebarAction({
  onClick,
  icon,
  label,
  collapsed,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  collapsed: boolean;
}) {
  return (
    <div className="relative group">
      <button
        onClick={onClick}
        className="flex items-center gap-3 w-full mx-2 px-3 py-2.5 rounded-lg transition-colors text-gray-400 hover:text-white hover:bg-white/5"
      >
        <span className="flex-none">{icon}</span>
        <span
          className={[
            "text-sm font-medium whitespace-nowrap overflow-hidden transition-[max-width,opacity] duration-200",
            collapsed ? "max-w-0 opacity-0" : "max-w-[160px] opacity-100",
          ].join(" ")}
        >
          {label}
        </span>
      </button>
      {collapsed && (
        <div className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-3 z-50 opacity-0 group-hover:opacity-100 transition-opacity duration-100">
          <div className="bg-gray-800 text-white text-xs font-medium px-2 py-1 rounded border border-gray-700 whitespace-nowrap shadow-lg">
            {label}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const { unresolvedFailures, syncStatus } = loaderData;
  const [isDark, setIsDark] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains("dark"));
    if (localStorage.getItem("sidebar-collapsed") === "true") setCollapsed(true);
  }, []);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem("sidebar-collapsed", String(next));
  }

  function toggleDark() {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Sidebar */}
      <aside
        className={[
          "fixed top-0 bottom-0 left-0 bg-gray-900 flex flex-col z-40",
          "transition-[width] duration-200 ease-in-out",
          collapsed ? "w-[60px]" : "w-[220px]",
        ].join(" ")}
      >
        {/* Collapse toggle — sits on the right edge of the sidebar */}
        <button
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="absolute -right-3 top-[22px] w-6 h-6 flex items-center justify-center rounded-full bg-gray-700 border border-gray-600 text-gray-300 hover:text-white hover:bg-gray-600 transition-colors z-50 shadow-sm"
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
        </button>

        {/* Logo */}
        <div className="flex items-center h-14 px-4 flex-none border-b border-white/5 overflow-hidden">
          <span className="text-indigo-400 font-bold text-lg tracking-tight flex-none select-none">R</span>
          <span
            className={[
              "text-indigo-400 font-bold text-lg tracking-tight overflow-hidden whitespace-nowrap select-none",
              "transition-[max-width,opacity] duration-200",
              collapsed ? "max-w-0 opacity-0" : "max-w-[160px] opacity-100",
            ].join(" ")}
          >
            eceively
          </span>
        </div>

        {/* Nav links */}
        <nav className="flex-1 py-2 flex flex-col gap-0.5">
          <SidebarLink to="/dashboard" icon={<LayoutDashboard size={18} />} label="Dashboard" collapsed={collapsed} />
          <SidebarLink to="/products" icon={<Package size={18} />} label="Products" collapsed={collapsed} />
          <SidebarLink to="/invoices" icon={<ShoppingCart size={18} />} label="Purchase Orders" collapsed={collapsed} />
          <SidebarLink to="/suppliers" icon={<Truck size={18} />} label="Suppliers" collapsed={collapsed} />
          <SidebarLink to="/vendors" icon={<Store size={18} />} label="Vendors" collapsed={collapsed} />
          <SidebarLink to="/credits" icon={<CreditCard size={18} />} label="Credits" collapsed={collapsed} />
          <SidebarLink to="/users" icon={<Users size={18} />} label="Users" collapsed={collapsed} />
          <SidebarLink
            to="/failures"
            icon={<AlertTriangle size={18} />}
            label="Failures"
            badge={unresolvedFailures}
            collapsed={collapsed}
          />
          <SidebarLink to="/audit" icon={<ScrollText size={18} />} label="Audit Log" collapsed={collapsed} />
          <SidebarLink to="/reports" icon={<BarChart2 size={18} />} label="Reports" collapsed={collapsed} />
          <SidebarLink to="/settings" icon={<Settings size={18} />} label="Settings" collapsed={collapsed} />
        </nav>

        {/* Bottom: sync + dark mode + sign out */}
        <div className="flex-none border-t border-white/5 pt-2 pb-3 flex flex-col gap-0.5">
          <SyncButton initialStatus={syncStatus} collapsed={collapsed} />
          <SidebarAction
            onClick={toggleDark}
            icon={isDark ? <Sun size={18} /> : <Moon size={18} />}
            label={isDark ? "Light mode" : "Dark mode"}
            collapsed={collapsed}
          />
          <div className="relative group">
            <form method="post" action="/logout" className="mx-2">
              <button
                type="submit"
                className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg transition-colors text-gray-400 hover:text-white hover:bg-white/5"
              >
                <LogOut size={18} className="flex-none" />
                <span
                  className={[
                    "text-sm font-medium whitespace-nowrap overflow-hidden transition-[max-width,opacity] duration-200",
                    collapsed ? "max-w-0 opacity-0" : "max-w-[160px] opacity-100",
                  ].join(" ")}
                >
                  Sign out
                </span>
              </button>
            </form>
            {collapsed && (
              <div className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-3 z-50 opacity-0 group-hover:opacity-100 transition-opacity duration-100">
                <div className="bg-gray-800 text-white text-xs font-medium px-2 py-1 rounded border border-gray-700 whitespace-nowrap shadow-lg">
                  Sign out
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Main content — shifts right to match sidebar width */}
      <div
        className={[
          "min-h-screen transition-[margin] duration-200 ease-in-out",
          collapsed ? "ml-[60px]" : "ml-[220px]",
        ].join(" ")}
      >
        <Outlet />
      </div>
    </div>
  );
}
