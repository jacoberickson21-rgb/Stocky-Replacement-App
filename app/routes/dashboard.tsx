import { data } from "react-router";
import type { Route } from "./+types/dashboard";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const user = await getDb().user.findUniqueOrThrow({ where: { id: userId } });
  return data({ name: user.name });
}

export default function DashboardPage({ loaderData }: Route.ComponentProps) {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-800">
          Stocky — Dashboard
        </h1>
        <form method="post" action="/logout">
          <button
            type="submit"
            className="text-sm text-gray-500 hover:text-gray-800 transition-colors"
          >
            Sign out
          </button>
        </form>
      </header>

      <main className="p-8">
        <p className="text-gray-600">
          Welcome back, <span className="font-medium">{loaderData.name}</span>.
        </p>
        <p className="mt-4 text-sm text-gray-400">
          Dashboard coming soon.
        </p>
      </main>
    </div>
  );
}
