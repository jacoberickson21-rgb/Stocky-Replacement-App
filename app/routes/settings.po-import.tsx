import { data } from "react-router";
import type { Route } from "./+types/settings.po-import";
import { requireUserId } from "../session.server";
import { importPOsFromCSV } from "../utils/po-import.server";

export async function action({ request }: Route.ActionArgs) {
  console.log("[po-import] action called, method:", request.method);
  await requireUserId(request);

  const form = await request.formData();
  console.log("[po-import] form data keys:", [...form.keys()]);

  const file = form.get("csv");
  if (file instanceof File) {
    console.log("[po-import] file found — name:", file.name, "size:", file.size, "type:", file.type);
  } else {
    console.log("[po-import] no file found, csv field value:", file);
  }

  if (!file || !(file instanceof File) || file.size === 0) {
    return data({ error: "Please select a CSV file.", result: null }, { status: 400 });
  }

  const csvText = await file.text();

  try {
    const result = await importPOsFromCSV(csvText);
    return data({ error: null, result });
  } catch (err) {
    console.error("[po-import] import threw:", err);
    return data(
      { error: err instanceof Error ? err.message : "Import failed.", result: null },
      { status: 500 },
    );
  }
}
