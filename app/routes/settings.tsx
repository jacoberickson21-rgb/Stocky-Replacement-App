import { Form, data, useActionData, useNavigation, useFetcher } from "react-router";
import { useEffect, useState } from "react";
import type { Route } from "./+types/settings";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";
import { getSyncStatus, resetRunningSyncs } from "../services/sync.server";
import type { SyncLogData } from "../services/sync.server";
import type { POImportResult } from "../utils/po-import.server";

const SETTINGS_KEYS = ["marginFloor", "lowStockThreshold", "autoSyncEnabled", "autoSyncIntervalHours", "salesHistoryDays"] as const;
const DEFAULTS: Record<typeof SETTINGS_KEYS[number], string> = {
  marginFloor: "40",
  lowStockThreshold: "5",
  autoSyncEnabled: "true",
  autoSyncIntervalHours: "24",
  salesHistoryDays: "90",
};

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const db = getDb();
  const [rows, syncStatus] = await Promise.all([
    db.appSetting.findMany({ where: { key: { in: [...SETTINGS_KEYS] } } }),
    getSyncStatus(),
  ]);
  const settings = Object.fromEntries(SETTINGS_KEYS.map((k) => [k, DEFAULTS[k]])) as Record<typeof SETTINGS_KEYS[number], string>;
  for (const row of rows) settings[row.key as typeof SETTINGS_KEYS[number]] = row.value;
  return { settings, syncStatus };
}

export async function action({ request }: Route.ActionArgs) {
  await requireUserId(request);
  const db = getDb();
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "saveGeneral") {
    const marginFloorRaw = String(formData.get("marginFloor") ?? "").trim();
    const lowStockRaw = String(formData.get("lowStockThreshold") ?? "").trim();
    const marginFloor = parseFloat(marginFloorRaw);
    const lowStock = parseInt(lowStockRaw);

    if (isNaN(marginFloor) || marginFloor < 0 || marginFloor > 100) {
      return data({ intent: "saveGeneral", error: "Margin floor must be 0–100." }, { status: 422 });
    }
    if (isNaN(lowStock) || lowStock < 0) {
      return data({ intent: "saveGeneral", error: "Low stock threshold must be a non-negative number." }, { status: 422 });
    }

    await db.$transaction([
      db.appSetting.upsert({ where: { key: "marginFloor" }, update: { value: String(marginFloor) }, create: { key: "marginFloor", value: String(marginFloor) } }),
      db.appSetting.upsert({ where: { key: "lowStockThreshold" }, update: { value: String(lowStock) }, create: { key: "lowStockThreshold", value: String(lowStock) } }),
    ]);
    return data({ intent: "saveGeneral", error: null });
  }

  if (intent === "saveSync") {
    const autoEnabled = formData.get("autoSyncEnabled") === "true" ? "true" : "false";
    const intervalRaw = String(formData.get("autoSyncIntervalHours") ?? "").trim();
    const daysRaw = String(formData.get("salesHistoryDays") ?? "").trim();
    const interval = parseFloat(intervalRaw);
    const days = parseInt(daysRaw);

    if (isNaN(interval) || interval < 1) {
      return data({ intent: "saveSync", error: "Sync interval must be at least 1 hour." }, { status: 422 });
    }
    if (isNaN(days) || days < 1 || days > 730) {
      return data({ intent: "saveSync", error: "Sales history must be between 1 and 730 days." }, { status: 422 });
    }

    await db.$transaction([
      db.appSetting.upsert({ where: { key: "autoSyncEnabled" }, update: { value: autoEnabled }, create: { key: "autoSyncEnabled", value: autoEnabled } }),
      db.appSetting.upsert({ where: { key: "autoSyncIntervalHours" }, update: { value: String(interval) }, create: { key: "autoSyncIntervalHours", value: String(interval) } }),
      db.appSetting.upsert({ where: { key: "salesHistoryDays" }, update: { value: String(days) }, create: { key: "salesHistoryDays", value: String(days) } }),
    ]);
    return data({ intent: "saveSync", error: null });
  }

  if (intent === "reset") {
    const resetCount = await resetRunningSyncs();
    return data({ intent: "reset", error: null, resetCount });
  }

  if (intent === "clearPOs") {
    const [, invoiceResult] = await db.$transaction([
      db.invoiceLineItem.deleteMany({}),
      db.invoice.deleteMany({}),
    ]);
    return data({ intent: "clearPOs", error: null, deletedCount: invoiceResult.count });
  }

  return data({ intent: "unknown", error: null });
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins !== 1 ? "s" : ""} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs !== 1 ? "s" : ""} ago`;
  return `${Math.floor(hrs / 24)} day${Math.floor(hrs / 24) !== 1 ? "s" : ""} ago`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

export default function SettingsPage({ loaderData }: Route.ComponentProps) {
  const { settings, syncStatus: initialSyncStatus } = loaderData;
  const actionData = useActionData() as { intent: string; error: string | null; resetCount?: number; deletedCount?: number } | undefined;
  const navigation = useNavigation();
  const syncFetcher = useFetcher<SyncLogData>();
  const fullSyncFetcher = useFetcher<SyncLogData>();
  const poImportFetcher = useFetcher<{ error: string | null; result: POImportResult | null }>();
  const [syncStatus, setSyncStatus] = useState<SyncLogData | null>(initialSyncStatus);
  const [autoEnabled, setAutoEnabled] = useState(settings.autoSyncEnabled === "true");
  const [poImportKey, setPoImportKey] = useState(0);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const isRunning = syncStatus?.status === "RUNNING" || syncFetcher.state !== "idle" || fullSyncFetcher.state !== "idle";
  const isStuckRunning =
    syncStatus?.status === "RUNNING" &&
    Date.now() - new Date(syncStatus.startedAt).getTime() > 5 * 60_000;
  const isResetting = navigation.state === "submitting" && navigation.formData?.get("intent") === "reset";
  const resetDone = navigation.state === "idle" && actionData?.intent === "reset" && !actionData.error;

  // Poll while syncing
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => {
      fetch("/api/sync")
        .then((r) => r.json())
        .then((d) => setSyncStatus(d as SyncLogData))
        .catch(() => {});
    }, 3000);
    return () => clearInterval(id);
  }, [isRunning]);

  useEffect(() => {
    if (syncFetcher.data) setSyncStatus(syncFetcher.data as SyncLogData);
  }, [syncFetcher.data]);

  useEffect(() => {
    if (fullSyncFetcher.data) setSyncStatus(fullSyncFetcher.data as SyncLogData);
  }, [fullSyncFetcher.data]);

  useEffect(() => {
    if (poImportFetcher.data?.result) setPoImportKey((k) => k + 1);
  }, [poImportFetcher.data]);

  const isSavingGeneral = navigation.state === "submitting" && navigation.formData?.get("intent") === "saveGeneral";
  const isSavingSync = navigation.state === "submitting" && navigation.formData?.get("intent") === "saveSync";
  const savedGeneral = navigation.state === "idle" && actionData?.intent === "saveGeneral" && !actionData.error;
  const savedSync = navigation.state === "idle" && actionData?.intent === "saveSync" && !actionData.error;
  const isClearingPOs = navigation.state === "submitting" && navigation.formData?.get("intent") === "clearPOs";
  const clearedPOs = navigation.state === "idle" && actionData?.intent === "clearPOs" && !actionData.error;

  const inputClass = "border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100";
  const saveBtn = (saving: boolean) =>
    `bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-5 py-2 transition-colors ${saving ? "opacity-60" : ""}`;

  return (
    <main className="p-8 max-w-2xl mx-auto space-y-8">
      <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Settings</h2>

      {/* General Settings */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-5">General</h3>
        <Form method="post">
          <input type="hidden" name="intent" value="saveGeneral" />
          <div className="space-y-5">
            <div>
              <label htmlFor="marginFloor" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Margin Floor (%)
              </label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                Products received below this gross margin are flagged on the dashboard.
              </p>
              <div className="flex items-center gap-2">
                <input id="marginFloor" name="marginFloor" type="number" min="0" max="100" step="0.1"
                  defaultValue={settings.marginFloor} className={`w-28 ${inputClass}`} />
                <span className="text-sm text-gray-500 dark:text-gray-400">%</span>
              </div>
            </div>
            <div>
              <label htmlFor="lowStockThreshold" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Low Stock Threshold
              </label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                Variants with inventory at or below this level are flagged.
              </p>
              <div className="flex items-center gap-2">
                <input id="lowStockThreshold" name="lowStockThreshold" type="number" min="0" step="1"
                  defaultValue={settings.lowStockThreshold} className={`w-28 ${inputClass}`} />
                <span className="text-sm text-gray-500 dark:text-gray-400">units</span>
              </div>
            </div>
          </div>
          {actionData?.intent === "saveGeneral" && actionData.error && (
            <p className="text-sm text-red-600 dark:text-red-400 mt-4">{actionData.error}</p>
          )}
          {savedGeneral && <p className="text-sm text-green-600 dark:text-green-400 mt-4">Saved.</p>}
          <button type="submit" disabled={isSavingGeneral} className={`mt-5 ${saveBtn(isSavingGeneral)}`}>
            {isSavingGeneral ? "Saving…" : "Save"}
          </button>
        </Form>
      </div>

      {/* Sync Settings */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-5">Data Sync</h3>

        {/* Sync status display */}
        <div className="mb-5 p-4 rounded-xl bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
          {!syncStatus && (
            <p className="text-sm text-gray-500 dark:text-gray-400">No sync has run yet.</p>
          )}
          {syncStatus?.status === "RUNNING" && (
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm text-indigo-600 dark:text-indigo-400">
                <svg className="animate-spin h-4 w-4 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span>
                  Syncing…{" "}
                  {syncStatus.totalVariants
                    ? `${(syncStatus.currentVariant ?? 0).toLocaleString()} / ${syncStatus.totalVariants.toLocaleString()} variants`
                    : syncStatus.currentVariant
                    ? `${syncStatus.currentVariant.toLocaleString()} variants fetched`
                    : ""}
                </span>
              </div>
              {syncStatus.errorMessage && (
                <p className="text-xs text-gray-500 dark:text-gray-400 font-mono pl-6">{syncStatus.errorMessage}</p>
              )}
              {isStuckRunning && (
                <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                    This sync has been running for more than 5 minutes and may be stuck.
                  </p>
                  <Form method="post">
                    <input type="hidden" name="intent" value="reset" />
                    <button
                      type="submit"
                      disabled={isResetting}
                      className="border border-red-500 text-red-600 dark:text-red-400 dark:border-red-500 hover:bg-red-50 dark:hover:bg-red-950 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium rounded-lg px-4 py-2 transition-colors"
                    >
                      {isResetting ? "Resetting…" : "Reset Stuck Syncs"}
                    </button>
                  </Form>
                </div>
              )}
            </div>
          )}
          {syncStatus?.status === "COMPLETE" && (
            <div className="text-sm text-gray-700 dark:text-gray-200 space-y-1">
              <p className="font-medium text-green-700 dark:text-green-400">Last sync completed successfully</p>
              <p className="text-gray-500 dark:text-gray-400">
                {syncStatus.syncType ?? "FULL"} · {syncStatus.completedAt ? timeAgo(syncStatus.completedAt) : "—"} ·{" "}
                {(syncStatus.syncType ?? "FULL") === "INCREMENTAL"
                  ? `${(syncStatus.variantsSynced ?? 0).toLocaleString()} variants updated`
                  : `${(syncStatus.variantsSynced ?? 0).toLocaleString()} variants in DB`
                } ·{" "}
                {(syncStatus.salesDaysSynced ?? 0).toLocaleString()} sales-days ·{" "}
                {syncStatus.durationMs ? fmtDuration(syncStatus.durationMs) : ""}
              </p>
            </div>
          )}
          {syncStatus?.status === "ERROR" && (
            <div className="text-sm space-y-1">
              <p className="font-medium text-red-600 dark:text-red-400">Last sync failed</p>
              {syncStatus.errorMessage && (
                <p className="text-gray-500 dark:text-gray-400 text-xs font-mono truncate">{syncStatus.errorMessage}</p>
              )}
            </div>
          )}
        </div>

        <div className="mb-5 flex items-center gap-3 flex-wrap">
          <syncFetcher.Form method="post" action="/api/sync">
            <button
              type="submit"
              disabled={isRunning}
              className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
            >
              {isRunning ? "Syncing…" : "Sync Now"}
            </button>
          </syncFetcher.Form>
          <fullSyncFetcher.Form method="post" action="/api/sync">
            <input type="hidden" name="forceFull" value="true" />
            <button
              type="submit"
              disabled={isRunning}
              className="border border-indigo-500 text-indigo-600 dark:text-indigo-400 dark:border-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-950 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium rounded-lg px-4 py-2 transition-colors"
            >
              Full Sync
            </button>
          </fullSyncFetcher.Form>
          {resetDone && (
            <p className="text-sm text-green-600 dark:text-green-400">
              {actionData!.resetCount === 1 ? "1 stuck sync cleared." : `${actionData!.resetCount} stuck syncs cleared.`}
            </p>
          )}
        </div>

        <div className="border-t border-gray-200 dark:border-gray-700 pt-5">
          <Form method="post">
            <input type="hidden" name="intent" value="saveSync" />
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Auto Sync</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    Automatically sync data on a schedule.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setAutoEnabled((v) => !v)}
                  className={[
                    "relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none",
                    autoEnabled ? "bg-indigo-600" : "bg-gray-300 dark:bg-gray-600",
                  ].join(" ")}
                >
                  <span className={[
                    "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                    autoEnabled ? "translate-x-6" : "translate-x-1",
                  ].join(" ")} />
                </button>
                <input type="hidden" name="autoSyncEnabled" value={autoEnabled ? "true" : "false"} />
              </div>

              <div>
                <label htmlFor="autoSyncIntervalHours" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Sync Interval
                </label>
                <div className="flex items-center gap-2">
                  <input id="autoSyncIntervalHours" name="autoSyncIntervalHours" type="number" min="1" step="1"
                    defaultValue={settings.autoSyncIntervalHours} className={`w-28 ${inputClass}`} />
                  <span className="text-sm text-gray-500 dark:text-gray-400">hours</span>
                </div>
              </div>

              <div>
                <label htmlFor="salesHistoryDays" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Sales History Lookback
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                  How many days of order history to sync (max 730).
                </p>
                <div className="flex items-center gap-2">
                  <input id="salesHistoryDays" name="salesHistoryDays" type="number" min="1" max="730" step="1"
                    defaultValue={settings.salesHistoryDays} className={`w-28 ${inputClass}`} />
                  <span className="text-sm text-gray-500 dark:text-gray-400">days</span>
                </div>
              </div>
            </div>

            {actionData?.intent === "saveSync" && actionData.error && (
              <p className="text-sm text-red-600 dark:text-red-400 mt-4">{actionData.error}</p>
            )}
            {savedSync && <p className="text-sm text-green-600 dark:text-green-400 mt-4">Saved.</p>}
            <button type="submit" disabled={isSavingSync} className={`mt-5 ${saveBtn(isSavingSync)}`}>
              {isSavingSync ? "Saving…" : "Save Sync Settings"}
            </button>
          </Form>
        </div>
      </div>
      {/* Import Historical POs */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-1">Import Historical POs</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-5">
          Import header-only purchase order history from a Stocky CSV export. Existing invoice numbers are skipped.
        </p>
        <poImportFetcher.Form
          key={poImportKey}
          method="post"
          action="/settings/po-import"
          encType="multipart/form-data"
          className="flex items-center gap-3 flex-wrap"
        >
          <input
            type="file"
            name="csv"
            accept=".csv"
            required
            className="text-sm text-gray-700 dark:text-gray-300 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-indigo-50 file:text-indigo-700 dark:file:bg-indigo-900 dark:file:text-indigo-300 hover:file:bg-indigo-100 dark:hover:file:bg-indigo-800 file:cursor-pointer"
          />
          <button
            type="submit"
            disabled={poImportFetcher.state !== "idle"}
            className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-5 py-2 transition-colors shrink-0"
          >
            {poImportFetcher.state !== "idle" ? "Importing…" : "Import"}
          </button>
        </poImportFetcher.Form>

        {poImportFetcher.data?.error && (
          <p className="mt-4 text-sm text-red-600 dark:text-red-400">{poImportFetcher.data.error}</p>
        )}

        {poImportFetcher.data?.result && (
          <div className="mt-4 p-4 rounded-xl bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 space-y-2">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-200">Import complete</p>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {poImportFetcher.data.result.imported} imported
              {" · "}
              {poImportFetcher.data.result.skipped} skipped (duplicate)
              {" · "}
              {poImportFetcher.data.result.vendorsCreated} vendor{poImportFetcher.data.result.vendorsCreated !== 1 ? "s" : ""} created
            </p>
            {poImportFetcher.data.result.errors.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-red-600 dark:text-red-400">
                  {poImportFetcher.data.result.errors.length} error{poImportFetcher.data.result.errors.length !== 1 ? "s" : ""}:
                </p>
                <ul className="text-xs text-red-500 dark:text-red-400 space-y-0.5 max-h-40 overflow-y-auto">
                  {poImportFetcher.data.result.errors.map((e, idx) => (
                    <li key={idx}>Row {e.row}: {e.message}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Danger Zone */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-red-200 dark:border-red-900/60 p-6">
        <h3 className="text-sm font-semibold text-red-600 dark:text-red-400 mb-1">Danger Zone</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-5">
          Destructive actions that cannot be undone.
        </p>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Clear Purchase Orders</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Permanently delete all invoices and line items. Vendors, suppliers, credits, and settings are preserved.
            </p>
          </div>
          {!showClearConfirm ? (
            <button
              onClick={() => setShowClearConfirm(true)}
              disabled={isClearingPOs}
              className="shrink-0 border border-red-500 text-red-600 dark:text-red-400 dark:border-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium rounded-lg px-4 py-2 transition-colors"
            >
              Clear POs
            </button>
          ) : (
            <div className="shrink-0 flex items-center gap-2">
              <Form method="post" onSubmit={() => setShowClearConfirm(false)}>
                <input type="hidden" name="intent" value="clearPOs" />
                <button
                  type="submit"
                  disabled={isClearingPOs}
                  className="bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
                >
                  {isClearingPOs ? "Deleting…" : "Yes, delete all"}
                </button>
              </Form>
              <button
                type="button"
                onClick={() => setShowClearConfirm(false)}
                className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
        {clearedPOs && (
          <p className="text-sm text-green-600 dark:text-green-400 mt-4">
            Deleted {actionData!.deletedCount} invoice{actionData!.deletedCount !== 1 ? "s" : ""}.
          </p>
        )}
      </div>
    </main>
  );
}
