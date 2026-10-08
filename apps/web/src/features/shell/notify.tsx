"use client";

import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type Severity = "success" | "info" | "warning" | "error";

interface Notice {
  key: number;
  message: string;
  severity: Severity;
}

const NotifyContext = createContext<(message: string, severity?: Severity) => void>(() => {});

/** Toast notifications (action errors, saved, committed ...). */
export function NotifyProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const notify = useCallback((message: string, severity: Severity = "info") => {
    setNotice({ key: Date.now(), message, severity });
  }, []);
  return (
    <NotifyContext.Provider value={notify}>
      {children}
      <Snackbar
        key={notice?.key}
        open={notice !== null}
        autoHideDuration={notice?.severity === "error" ? 8000 : 3000}
        onClose={() => setNotice(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Alert severity={notice?.severity ?? "info"} variant="filled" onClose={() => setNotice(null)} sx={{ maxWidth: 560, whiteSpace: "pre-wrap" }}>
          {notice?.message}
        </Alert>
      </Snackbar>
    </NotifyContext.Provider>
  );
}

export function useNotify() {
  return useContext(NotifyContext);
}

/** Run an async task, reporting a failure as an error toast. */
export function useGuard() {
  const notify = useNotify();
  return useCallback(
    async <T,>(task: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await task();
      } catch (e) {
        notify((e as Error).message, "error");
        return undefined;
      }
    },
    [notify],
  );
}
