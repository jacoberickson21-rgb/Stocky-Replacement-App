export const statusStyles: Record<string, string> = {
  PREPARING: "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300",
  IN_PROGRESS: "bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300",
  REVIEW: "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300",
  APPLYING: "bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300",
  COMPLETED: "bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300",
  CANCELLED: "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400",
};

export const statusLabels: Record<string, string> = {
  PREPARING: "Preparing",
  IN_PROGRESS: "In progress",
  REVIEW: "Review",
  APPLYING: "Applying",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export const modeLabels: Record<string, string> = { SCOPED: "Scoped", FREE_SCAN: "Free scan" };
