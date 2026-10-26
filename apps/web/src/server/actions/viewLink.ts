"use server";

import { ID } from "@/lib/dashboards/config";

import { viewHost } from "../auth/access";
import { requireUser } from "../auth/session";
import { attempt, type ActionResult } from "../result";

/** Where to open a dashboard's shared view: on the view host (`IARA_VIEW_HOST`) when there is one, else on this Studio. */
export async function viewLink(id: string): Promise<ActionResult<string>> {
  return attempt(async () => {
    await requireUser();
    if (!ID.test(id)) throw new Error("invalid dashboard id");
    const host = viewHost();
    return host ? `https://${host}/view/${id}` : `/view/${id}`;
  });
}
