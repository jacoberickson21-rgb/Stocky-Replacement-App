import { NavLink, Outlet, useFetcher } from "react-router";
import { useState, useEffect, useRef } from "react";
import type { Route } from "./+types/app";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";
import { getSyncStatus } from "../services/sync.server";
import type { SyncLogData } from "../services/sync.server";

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

function SunIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg className="animate-spin h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
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

function SyncButton({ initialStatus }: { initialStatus: SyncLogData | null }) {
  const [status, setStatus] = useState<SyncLogData | null>(initialStatus);
  const fetcher = useFetcher<SyncLogData>();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isRunning = status?.status === "RUNNING" || fetcher.state !== "idle";

  // Start/stop polling when status becomes RUNNING
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

  // Sync fetcher result back into local state
  useEffect(() => {
    if (fetcher.data) setStatus(fetcher.data as SyncLogData);
  }, [fetcher.data]);

  function triggerSync() {
    fetcher.submit({}, { method: "POST", action: "/api/sync" });
  }

  const current = status?.currentVariant ?? 0;
  const total = status?.totalVariants;
  const progressLabel = total ? `${current} / ${total}` : current > 0 ? `${current}…` : "";

  return (
    <div className="flex flex-col items-end gap-0.5">
      <button
        onClick={triggerSync}
        disabled={isRunning}
        className={[
          "flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md transition-colors",
          isRunning
            ? "bg-indigo-50 dark:bg-indigo-950/50 text-indigo-500 dark:text-indigo-400 cursor-not-allowed"
            : "bg-indigo-600 hover:bg-indigo-700 text-white",
        ].join(" ")}
      >
        {isRunning && <SpinnerIcon />}
        {isRunning ? `Syncing${progressLabel ? ` ${progressLabel}` : "…"}` : "Sync Data"}
      </button>
      {!isRunning && status?.status === "COMPLETE" && status.completedAt && (
        <span className="text-[10px] text-gray-400 dark:text-gray-500 leading-none">
          Synced {timeAgo(status.completedAt)}
        </span>
      )}
      {!isRunning && status?.status === "ERROR" && (
        <span
          className="text-[10px] text-red-500 dark:text-red-400 leading-none cursor-help"
          title={status.errorMessage ?? "Unknown error"}
        >
          Last sync failed
        </span>
      )}
    </div>
  );
}

const baseLinkClass = "text-sm font-medium px-3 py-1.5 rounded-md transition-colors";
const activeLinkClass = `${baseLinkClass} text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/70`;
const inactiveLinkClass = `${baseLinkClass} text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800`;

const linkClass = ({ isActive }: { isActive: boolean }) =>
  isActive ? activeLinkClass : inactiveLinkClass;

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const { unresolvedFailures, syncStatus } = loaderData;
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggleDark = () => {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <nav className="bg-white dark:bg-gray-900 border-b border-indigo-100 dark:border-gray-800 px-6 flex items-center justify-between h-14 shadow-sm">
        <div className="flex items-center gap-1">
          <span className="text-lg font-bold text-indigo-600 dark:text-indigo-400 tracking-tight mr-4">
            Receively
          </span>
          <div className="w-px h-5 bg-gray-200 dark:bg-gray-700 mr-3" />
          <NavLink to="/dashboard" className={linkClass}>Dashboard</NavLink>
          <NavLink to="/products" className={linkClass}>Products</NavLink>
          <NavLink to="/invoices" className={linkClass}>Purchase Orders</NavLink>
          <NavLink to="/suppliers" className={linkClass}>Suppliers</NavLink>
          <NavLink to="/vendors" className={linkClass}>Vendors</NavLink>
          <NavLink to="/credits" className={linkClass}>Credits</NavLink>
          <NavLink to="/users" className={linkClass}>Users</NavLink>
          <NavLink
            to="/failures"
            className={({ isActive }) =>
              `relative flex items-center gap-1.5 ${isActive ? activeLinkClass : inactiveLinkClass}`
            }
          >
            Failures
            {unresolvedFailures > 0 && (
              <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-xs font-bold leading-none">
                {unresolvedFailures > 99 ? "99+" : unresolvedFailures}
              </span>
            )}
          </NavLink>
          <NavLink to="/audit" className={linkClass}>Audit Log</NavLink>
          <NavLink to="/reports" className={linkClass}>Reports</NavLink>
          <NavLink to="/settings" className={linkClass}>Settings</NavLink>
        </div>

        <div className="flex items-center gap-3">
          <SyncButton initialStatus={syncStatus} />
          <div className="w-px h-4 bg-gray-200 dark:bg-gray-700" />
          <button
            onClick={toggleDark}
            aria-label="Toggle dark mode"
            className="p-1.5 rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            {isDark ? <SunIcon /> : <MoonIcon />}
          </button>
          <div className="w-px h-4 bg-gray-200 dark:bg-gray-700" />
          <form method="post" action="/logout">
            <button
              type="submit"
              className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
            >
              Sign out
            </button>
          </form>
        </div>
      </nav>
      <Outlet />
    </div>
  );
}
