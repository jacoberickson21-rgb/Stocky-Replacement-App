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
    <main className="p-8">
        <p className="text-gray-600">
          Welcome back, <span className="font-medium">{loaderData.name}</span>.
        </p>
        <p className="mt-4 text-sm text-gray-400">
          Dashboard coming soon.
        </p>
      </main>
  );
}
