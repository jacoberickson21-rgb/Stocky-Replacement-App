import { Form, data, useActionData, useNavigation } from "react-router";
import type { Route } from "./+types/settings";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const db = getDb();
  const setting = await db.appSetting.findUnique({ where: { key: "marginFloor" } });
  return { marginFloor: setting?.value ?? "40" };
}

export async function action({ request }: Route.ActionArgs) {
  await requireUserId(request);
  const db = getDb();
  const formData = await request.formData();
  const raw = String(formData.get("marginFloor") ?? "").trim();
  const parsed = parseFloat(raw);

  if (isNaN(parsed) || parsed < 0 || parsed > 100) {
    return data({ error: "Margin floor must be a number between 0 and 100." }, { status: 422 });
  }

  await db.appSetting.upsert({
    where: { key: "marginFloor" },
    update: { value: String(parsed) },
    create: { key: "marginFloor", value: String(parsed) },
  });

  return data({ error: null });
}

export default function SettingsPage({ loaderData }: Route.ComponentProps) {
  const { marginFloor } = loaderData;
  const actionData = useActionData() as { error: string | null } | undefined;
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting";
  const saved = navigation.state === "idle" && actionData?.error === null;

  return (
    <main className="p-8 max-w-xl mx-auto">
      <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100 mb-6">Settings</h2>

      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <Form method="post">
          <div className="mb-5">
            <label
              htmlFor="marginFloor"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Margin Floor (%)
            </label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
              Products received below this gross margin will be flagged on the dashboard.
            </p>
            <div className="flex items-center gap-2">
              <input
                id="marginFloor"
                name="marginFloor"
                type="number"
                min="0"
                max="100"
                step="0.1"
                defaultValue={marginFloor}
                className="w-28 border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100"
              />
              <span className="text-sm text-gray-500 dark:text-gray-400">%</span>
            </div>
          </div>

          {actionData?.error && (
            <p className="text-sm text-red-600 dark:text-red-400 mb-3">{actionData.error}</p>
          )}
          {saved && (
            <p className="text-sm text-green-600 dark:text-green-400 mb-3">Saved.</p>
          )}

          <button
            type="submit"
            disabled={isSaving}
            className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-5 py-2 transition-colors"
          >
            {isSaving ? "Saving…" : "Save"}
          </button>
        </Form>
      </div>
    </main>
  );
}
