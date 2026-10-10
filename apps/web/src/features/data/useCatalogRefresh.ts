"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";

import { useData } from "./DataProvider";

/** After statements changed the catalog: the Data panel and pages show it. */
export function useCatalogRefresh(): () => void {
  const router = useRouter();
  const { invalidate } = useData();
  return useCallback(() => {
    invalidate();
    router.refresh();
  }, [invalidate, router]);
}
