"use client";

import type { QueryParams } from "@iara/protocol";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { useGuard } from "@/features/shell/notify";
import { unwrap } from "@/lib/action";
import { analyzeQuery } from "@/server/actions/analyze";

/** Profiles a query on the workspace kernel, then opens its analysis. */
export function useAnalyze() {
  const router = useRouter();
  const guard = useGuard();
  const [pending, setPending] = useState(false);
  const analyze = useCallback(
    async (query: string, source?: string, values?: QueryParams) => {
      setPending(true);
      try {
        const done = await guard(async () => unwrap(await analyzeQuery(query, source, values)));
        if (done) router.push(`/analyze/${done.id}`);
      } finally {
        setPending(false);
      }
    },
    [guard, router],
  );
  return { analyze, pending };
}
