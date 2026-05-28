import { redirect, data } from "react-router";
import bcrypt from "bcryptjs";
import type { Route } from "./+types/login";
import { getDb } from "../db.server";
import { getSession, commitSession } from "../session.server";

// ─── In-memory rate limiter ────────────────────────────────────────────────────
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function getClientIp(request: Request): string {
  return (
    request.headers.get("X-Forwarded-For")?.split(",")[0].trim() ??
    request.headers.get("CF-Connecting-IP") ??
    "unknown"
  );
}

function checkRateLimit(ip: string): boolean {
  const entry = loginAttempts.get(ip);
  if (!entry || Date.now() > entry.resetAt) return false;
  return entry.count >= RATE_LIMIT_MAX;
}

function recordFailedAttempt(ip: string): void {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  } else {
    entry.count++;
  }
}

function clearAttempts(ip: string): void {
  loginAttempts.delete(ip);
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request.headers.get("Cookie"));
  if (session.get("userId")) throw redirect("/dashboard");
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  const ip = getClientIp(request);

  if (checkRateLimit(ip)) {
    return data(
      { error: "Too many login attempts. Please try again later." },
      { status: 429 },
    );
  }

  try {
    const form = await request.formData();
    const username = String(form.get("username") ?? "");
    const password = String(form.get("password") ?? "");

    const user = await getDb().user.findUnique({ where: { username } });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      recordFailedAttempt(ip);
      return data({ error: "Invalid username or password." }, { status: 401 });
    }

    clearAttempts(ip);
    const session = await getSession(request.headers.get("Cookie"));
    session.set("userId", user.id);

    return redirect("/dashboard", {
      headers: { "Set-Cookie": await commitSession(session) },
    });
  } catch (error) {
    console.error("[login] action error:", error);
    throw error;
  }
}

export default function LoginPage({ actionData }: Route.ComponentProps) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <span className="text-3xl font-bold text-indigo-600 dark:text-indigo-400 tracking-tight">
            Receively
          </span>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-800 p-8">
          <h1 className="text-xl font-semibold text-gray-800 dark:text-gray-100 mb-6 text-center">
            Staff Login
          </h1>

          {actionData?.error && (
            <p className="mb-4 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-lg px-4 py-2">
              {actionData.error}
            </p>
          )}

          <form method="post" className="space-y-4">
            <div>
              <label
                htmlFor="username"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                Username
              </label>
              <input
                id="username"
                name="username"
                type="text"
                required
                autoComplete="username"
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:focus:ring-indigo-400"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:focus:ring-indigo-400"
              />
            </div>

            <button
              type="submit"
              className="w-full bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600 text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors"
            >
              Sign in
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
