"use server";

import { requireAdmin } from "../auth/session";
import { checkedGrant, type Grant } from "../governance/grants";
import { readGrants, writeGrants } from "../governance/store";
import { attempt, type ActionResult } from "../result";

/** Who may read which tables through the Studio's mediated queries (team admins only). */

export async function listGrantsAction(): Promise<ActionResult<Grant[]>> {
  return attempt(async () => {
    await requireAdmin();
    return readGrants();
  });
}

/** Adds a grant (adding one that is there already changes nothing). Returns all the grants. */
export async function grantAction(to: string, on: string): Promise<ActionResult<Grant[]>> {
  return attempt(async () => {
    await requireAdmin();
    const grant = checkedGrant({ to, on });
    const grants = readGrants();
    if (grants.some((g) => g.to === grant.to && g.on === grant.on)) return grants;
    const next = [...grants, grant];
    writeGrants(next);
    return next;
  });
}

/** Removes a grant (removing one that is not there changes nothing). Returns all the grants. */
export async function revokeAction(to: string, on: string): Promise<ActionResult<Grant[]>> {
  return attempt(async () => {
    await requireAdmin();
    const { to: t, on: o } = checkedGrant({ to, on });
    const next = readGrants().filter((g) => g.to !== t || g.on !== o);
    writeGrants(next);
    return next;
  });
}
