import { Fragment, useEffect, useState } from "react";
import { useActionData, Form } from "react-router";
import bcrypt from "bcryptjs";
import type { Route } from "./+types/users";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";

export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await requireUserId(request);
  const users = await getDb().user.findMany({
    select: { id: true, name: true, username: true },
    orderBy: { name: "asc" },
  });
  return { users, currentUserId };
}

export async function action({ request }: Route.ActionArgs) {
  const currentUserId = await requireUserId(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  console.log(`[action] received intent="${intent}"`);
  const db = getDb();

  if (intent === "create") {
    const name = ((formData.get("name") as string) ?? "").trim();
    const username = ((formData.get("username") as string) ?? "").trim();
    const password = (formData.get("password") as string) ?? "";

    if (!name) return { intent, error: "Name is required." };
    if (!username) return { intent, error: "Username is required." };
    if (password.length < 8) return { intent, error: "Password must be at least 8 characters." };

    const existing = await db.user.findUnique({ where: { username } });
    if (existing) return { intent, error: `Username "${username}" is already taken.` };

    const passwordHash = await bcrypt.hash(password, 10);
    await db.user.create({ data: { name, username, passwordHash } });
    return { intent, success: true };
  }

  if (intent === "delete") {
    const userId = Number(formData.get("userId"));
    if (userId === currentUserId) {
      return { intent, error: "You cannot delete your own account." };
    }
    await db.user.delete({ where: { id: userId } });
    return { intent, success: true };
  }

  if (intent === "changePassword") {
    const targetUserId = parseInt(String(formData.get("userId") ?? ""), 10);
    const newPassword = String(formData.get("newPassword") ?? "");

    if (!targetUserId || isNaN(targetUserId)) {
      return { intent, targetUserId: 0, error: "Invalid user." };
    }
    if (newPassword.length < 8) {
      return { intent, targetUserId, error: "Password must be at least 8 characters." };
    }

    console.log(`[changePassword] attempting update for userId=${targetUserId}`);
    try {
      const passwordHash = await bcrypt.hash(newPassword, 10);
      console.log(`[changePassword] hash generated for userId=${targetUserId}`);
      const updated = await db.user.update({ where: { id: targetUserId }, data: { passwordHash } });
      console.log(`[changePassword] update complete, confirmed id=${updated.id}`);
    } catch (err) {
      console.error("[changePassword] update failed:", err);
      return { intent, targetUserId, error: "Failed to update password. Please try again." };
    }
    return { intent, targetUserId, success: true };
  }

  return null;
}

type ActionData = {
  intent: string;
  error?: string;
  success?: boolean;
  targetUserId?: number;
};

const inputClass =
  "border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800";

export default function UsersPage({ loaderData }: Route.ComponentProps) {
  const { users, currentUserId } = loaderData;
  const actionData = useActionData() as ActionData | undefined;
  const [showAddForm, setShowAddForm] = useState(false);
  const [openPasswordUserId, setOpenPasswordUserId] = useState<number | null>(null);

  useEffect(() => {
    if (actionData?.intent === "create" && actionData.success) {
      setShowAddForm(false);
    }
    if (actionData?.intent === "changePassword" && actionData.success) {
      setOpenPasswordUserId(null);
    }
  }, [actionData]);

  return (
    <main className="p-8 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Staff Accounts</h2>
        <button
          type="button"
          onClick={() => setShowAddForm(!showAddForm)}
          className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
        >
          {showAddForm ? "Cancel" : "Add Staff"}
        </button>
      </div>

      {showAddForm && (
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 mb-6">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">New Staff Account</h3>
          <form method="post">
            <input type="hidden" name="intent" value="create" />
            <div className="flex flex-col gap-3">
              <div className="flex gap-3">
                <input
                  name="name"
                  placeholder="Full name"
                  className={`${inputClass} flex-1`}
                  required
                />
                <input
                  name="username"
                  placeholder="Username"
                  className={`${inputClass} flex-1`}
                  required
                  autoCapitalize="none"
                  autoCorrect="off"
                />
                <input
                  name="password"
                  type="password"
                  placeholder="Password (min 8 chars)"
                  className={`${inputClass} flex-1`}
                  required
                />
              </div>
              <div className="flex items-center justify-between">
                {actionData?.intent === "create" && actionData.error ? (
                  <p className="text-sm text-red-600 dark:text-red-400">{actionData.error}</p>
                ) : (
                  <span />
                )}
                <button
                  type="submit"
                  className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
                >
                  Create Account
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
        {users.length === 0 ? (
          <p className="text-sm text-gray-400 dark:text-gray-500 p-6">No staff accounts found.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Name</th>
                <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Username</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <Fragment key={user.id}>
                  <tr className="border-b border-gray-100 dark:border-gray-700">
                    <td className="px-6 py-4 font-medium text-gray-800 dark:text-gray-100">
                      {user.name}
                      {user.id === currentUserId && (
                        <span className="ml-2 text-xs font-normal text-gray-400 dark:text-gray-500">(you)</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-gray-600 dark:text-gray-300">{user.username}</td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-5">
                        <button
                          type="button"
                          onClick={() =>
                            setOpenPasswordUserId(
                              openPasswordUserId === user.id ? null : user.id
                            )
                          }
                          className="text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 transition-colors"
                        >
                          Change Password
                        </button>
                        {user.id === currentUserId ? (
                          <span className="text-gray-300 dark:text-gray-600 text-xs select-none" title="You cannot delete your own account">
                            Delete
                          </span>
                        ) : (
                          <form method="post" className="inline">
                            <input type="hidden" name="intent" value="delete" />
                            <input type="hidden" name="userId" value={user.id} />
                            <button
                              type="submit"
                              className="text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 transition-colors"
                              onClick={(e) => {
                                if (!confirm(`Delete account for ${user.name}?`)) {
                                  e.preventDefault();
                                }
                              }}
                            >
                              Delete
                            </button>
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                  {openPasswordUserId === user.id && (
                    <tr className="bg-indigo-50 dark:bg-indigo-950/40 border-b border-gray-100 dark:border-gray-700">
                      <td colSpan={3} className="px-6 py-4">
                        <Form method="post" className="flex items-center gap-3 flex-wrap">
                          <input type="hidden" name="intent" value="changePassword" />
                          <input type="hidden" name="userId" value={user.id} />
                          <span className="text-sm text-gray-600 dark:text-gray-300 whitespace-nowrap">
                            New password for <strong>{user.name}</strong>:
                          </span>
                          <input
                            name="newPassword"
                            type="password"
                            placeholder="New password (min 8 chars)"
                            className={`${inputClass} w-64`}
                            required
                          />
                          <button
                            type="submit"
                            className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg px-3 py-2 transition-colors whitespace-nowrap"
                          >
                            Update Password
                          </button>
                          <button
                            type="button"
                            onClick={() => setOpenPasswordUserId(null)}
                            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                          >
                            Cancel
                          </button>
                          {actionData?.intent === "changePassword" &&
                            actionData.targetUserId === user.id && (
                              <>
                                {actionData.error && (
                                  <p className="text-sm text-red-600 dark:text-red-400">{actionData.error}</p>
                                )}
                              </>
                            )}
                        </Form>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
