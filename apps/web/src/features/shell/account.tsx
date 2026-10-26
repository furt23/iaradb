"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { AppAccount } from "./AccountMenu";

// without a provider the account is no admin: admin-only menu items stay hidden
const AccountContext = createContext<AppAccount>({ name: "", email: "", admin: false, signOut: false });

/** The signed-in account for the whole Studio shell (set by the studio layout). */
export function AccountProvider({ account, children }: { account: AppAccount; children: ReactNode }) {
  return <AccountContext.Provider value={account}>{children}</AccountContext.Provider>;
}

export function useAccount(): AppAccount {
  return useContext(AccountContext);
}
