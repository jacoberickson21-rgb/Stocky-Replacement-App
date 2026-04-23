import { createCookieSessionStorage, redirect } from "react-router";

console.log('ENV CHECK:', JSON.stringify({
  SESSION_SECRET_LENGTH: process.env.SESSION_SECRET?.length ?? 'MISSING',
  NODE_ENV: process.env.NODE_ENV,
}));

const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: "__session",
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secrets: [process.env.SESSION_SECRET ?? "temporary-insecure-secret"],
    secure: process.env.NODE_ENV === "production",
  },
});

export const { getSession, commitSession, destroySession } = sessionStorage;

export async function requireUserId(request: Request): Promise<number> {
  const session = await getSession(request.headers.get("Cookie"));
  const userId = session.get("userId");
  if (!userId) throw redirect("/login");
  return userId as number;
}
