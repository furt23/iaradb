"use server";

import { requireUser } from "../auth/session";
import { kernels } from "../kernel/manager";
import { attempt, type ActionResult } from "../result";
import { createSqlFile, readSqlFile, writeSqlFile } from "../workspace/sqlFiles";

/** Saved queries: `.sql` files of the workspace. */

export async function openQuery(path: string): Promise<ActionResult<{ path: string; text: string }>> {
  return attempt(async () => {
    await requireUser();
    return readSqlFile(path);
  });
}

/** Saves wait for renames and deletes in progress (and never recreate a moved file). */
export async function saveQuery(path: string, text: string): Promise<ActionResult<{ path: string }>> {
  return attempt(async () => {
    await requireUser();
    return kernels.exclusive(() => writeSqlFile(path, text));
  });
}

export async function createQuery(path: string, text = "select 1\n"): Promise<ActionResult<{ path: string }>> {
  return attempt(async () => {
    await requireUser();
    return kernels.exclusive(() => createSqlFile(path, text));
  });
}
