import { createCookieSessionStorage, redirect } from "react-router";

function getSessionStorage() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("SESSION_SECRET must be set to a string of at least 16 characters.");
  }
  return createCookieSessionStorage({
    cookie: {
      name: "__session",
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secrets: [secret],
      secure: process.env.NODE_ENV === "production",
    },
  });
}

const sessionStorage = getSessionStorage();

export const { getSession, commitSession, destroySession } = sessionStorage;

export async function requireUserId(request: Request): Promise<number> {
  const session = await getSession(request.headers.get("Cookie"));
  const userId = session.get("userId");
  if (!userId) throw redirect("/login");
  return userId as number;
}
