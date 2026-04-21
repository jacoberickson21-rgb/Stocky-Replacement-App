import { redirect } from "react-router";
import type { Route } from "./+types/logout";
import { getSession, destroySession } from "../session.server";

export async function action({ request }: Route.ActionArgs) {
  const session = await getSession(request.headers.get("Cookie"));
  return redirect("/login", {
    headers: { "Set-Cookie": await destroySession(session) },
  });
}
