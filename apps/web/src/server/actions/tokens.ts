"use server";

import { requireUser } from "../auth/session";
import { createToken, listTokens, revokeToken, type TokenSummary } from "../auth/tokens";
import { attempt, type ActionResult } from "../result";

/** The signed-in user's access tokens for MCP clients (never their secrets: those come back once, from create). */
export async function listTokensAction(): Promise<ActionResult<TokenSummary[]>> {
  return attempt(async () => listTokens((await requireUser()).email));
}

/** A new access token named `name`; its secret is returned once. */
export async function createTokenAction(name: string): Promise<ActionResult<{ id: string; token: string }>> {
  return attempt(async () => {
    const user = await requireUser();
    const label = name.trim();
    if (label.length < 1 || label.length > 60) throw new Error("the name must be 1 to 60 characters");
    if (!user.email) throw new Error("access tokens need a signed-in account");
    return createToken(user.email, label);
  });
}

export async function revokeTokenAction(id: string): Promise<ActionResult<void>> {
  return attempt(async () => {
    revokeToken((await requireUser()).email, id);
  });
}
