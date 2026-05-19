import { Link } from "react-router";
import type { Route } from "./+types/reports";
import { requireUserId } from "../session.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  return {};
}

const REPORTS = [
  {
    to: "/reports/margins",
    title: "Margin Report",
    description: "Identify products below your margin floor. Sorted worst-first with summary stats.",
    border: "border-rose-200 dark:border-rose-900",
    iconPath: "M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 11h.01M12 11h.01M15 11h.01M4 19h16a2 2 0 002-2V7a2 2 0 00-2-2H4a2 2 0 00-2 2v10a2 2 0 002 2z",
    iconColor: "text-rose-500 dark:text-rose-400",
  },
  {
    to: "/reports/vendor-performance",
    title: "Vendor Performance",
    description: "Spend, discrepancy rates, order cycles, and outstanding balances by vendor.",
    border: "border-indigo-200 dark:border-indigo-900",
    iconPath: "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z",
    iconColor: "text-indigo-500 dark:text-indigo-400",
  },
  {
    to: "/reports/inventory-valuation",
    title: "Inventory Valuation",
    description: "Current stock value at cost and retail, with potential margin by product.",
    border: "border-emerald-200 dark:border-emerald-900",
    iconPath: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4",
    iconColor: "text-emerald-500 dark:text-emerald-400",
  },
  {
    to: "/reports/spend-analysis",
    title: "Spend Analysis",
    description: "Spend over time, by vendor, and month-over-month with full invoice breakdown.",
    border: "border-amber-200 dark:border-amber-900",
    iconPath: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z",
    iconColor: "text-amber-500 dark:text-amber-400",
  },
  {
    to: "/reports/sales-velocity",
    title: "Sales Velocity",
    description: "Units sold, avg daily rate, and days of stock remaining — color-coded by urgency.",
    border: "border-sky-200 dark:border-sky-900",
    iconPath: "M13 7h8m0 0v8m0-8l-8 8-4-4-6 6",
    iconColor: "text-sky-500 dark:text-sky-400",
  },
  {
    to: "/reports/receiving-history",
    title: "Receiving History",
    description: "Full log of received shipments with staff, discrepancy counts, and invoice links.",
    border: "border-violet-200 dark:border-violet-900",
    iconPath: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4",
    iconColor: "text-violet-500 dark:text-violet-400",
  },
];

export default function ReportsPage() {
  return (
    <main className="p-8 max-w-5xl mx-auto">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Reports</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Choose a report to analyze purchasing, inventory, and vendor data.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {REPORTS.map((r) => (
          <Link
            key={r.to}
            to={r.to}
            className={`block bg-white dark:bg-gray-900 rounded-2xl border ${r.border} shadow-sm p-5 hover:shadow-md transition-shadow group`}
          >
            <div className="flex items-center gap-3 mb-2">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className={`h-5 w-5 flex-shrink-0 ${r.iconColor}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.8}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d={r.iconPath} />
              </svg>
              <h3 className="font-semibold text-gray-800 dark:text-gray-100 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                {r.title}
              </h3>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
              {r.description}
            </p>
          </Link>
        ))}
      </div>
    </main>
  );
}
