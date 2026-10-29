"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useNotify } from "@/features/shell/notify";
import type { Dataset } from "@/lib/dashboards/types";
import { type DatasetExtractStatus, extractStatus } from "@/server/actions/extracts";

/**
 * How each dataset reaches viewers, by name. Read when the Data tab is shown
 * and when the datasets change; `refresh` reads them again.
 */
export function useExtractStatus(slug: string, datasets: Dataset[], shown: boolean) {
  const notify = useNotify();
  const [statuses, setStatuses] = useState<Record<string, DatasetExtractStatus>>({});
  // only the newest read lands: an older one may come back after it
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++latest.current;
    const r = await extractStatus(slug);
    if (seq !== latest.current) return;
    if (r.ok) setStatuses(r.data);
    else notify(r.error.message, "error");
  }, [slug, notify]);

  useEffect(() => {
    if (shown) void refresh();
  }, [shown, datasets, refresh]);

  return { statuses, refresh };
}
