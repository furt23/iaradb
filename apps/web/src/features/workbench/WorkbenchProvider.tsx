"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";

import { activePath, emptyWorkbench, parseWorkbench, workbenchReducer, type WorkbenchAction, type WorkbenchState } from "./workbenchState";

const STORAGE_KEY = "workhouse.workbench.v1";

export function notebookHref(path: string): string {
  return `/notebooks/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** The notebook a pathname shows (`/notebooks/<path>`), if any. */
export function notebookFromPathname(pathname: string): string | null {
  const m = /^\/notebooks\/(.+)$/.exec(pathname);
  return m ? m[1].split("/").map(decodeURIComponent).join("/") : null;
}

function restore(): WorkbenchState {
  if (typeof window === "undefined") return emptyWorkbench();
  try {
    return parseWorkbench(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null")) ?? emptyWorkbench();
  } catch {
    return emptyWorkbench();
  }
}

export interface WorkbenchApi {
  state: WorkbenchState;
  /** the app is on a notebook route (the workbench is on screen) */
  visible: boolean;
  /**
   * Apply an action; then, if the workbench is on screen (or `reveal`), the
   * URL follows the focused pane's notebook.
   */
  act(action: WorkbenchAction, reveal?: boolean): void;
  /** Show the notebook the URL names (no navigation). */
  follow(path: string): void;
  /** Go to the focused notebook (from `/notebooks`). */
  showFocused(): void;
}

const WorkbenchContext = createContext<WorkbenchApi | null>(null);

/** The open notebook tabs and panes, shared by the file tree and the workbench. */
export function WorkbenchProvider({ children }: { children: ReactNode }) {
  // read on the client's first render: nothing renders from it before mount
  const [state, dispatch] = useReducer(workbenchReducer, undefined, restore);
  const stateRef = useRef(state);
  const pathname = usePathname();
  const router = useRouter();
  const visible = pathname === "/notebooks" || pathname.startsWith("/notebooks/");
  const route = useRef({ pathname, visible });
  route.current = { pathname, visible };

  useEffect(() => {
    stateRef.current = state;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // storage unavailable: tabs are not remembered
    }
  }, [state]);

  const navigate = useCallback(
    (next: WorkbenchState, push: boolean) => {
      const target = activePath(next);
      if (target === notebookFromPathname(route.current.pathname) && route.current.visible) return;
      const href = target ? notebookHref(target) : "/notebooks";
      if (push) router.push(href);
      else router.replace(href);
    },
    [router],
  );

  const act = useCallback(
    (action: WorkbenchAction, reveal = false) => {
      const next = workbenchReducer(stateRef.current, action);
      stateRef.current = next;
      dispatch(action);
      if (reveal || route.current.visible) navigate(next, reveal);
    },
    [navigate],
  );

  const follow = useCallback((path: string) => {
    const next = workbenchReducer(stateRef.current, { type: "open", path });
    if (next === stateRef.current) return;
    stateRef.current = next;
    dispatch({ type: "open", path });
  }, []);

  const showFocused = useCallback(() => {
    if (activePath(stateRef.current)) navigate(stateRef.current, false);
  }, [navigate]);

  const api = useMemo(() => ({ state, visible, act, follow, showFocused }), [state, visible, act, follow, showFocused]);
  return <WorkbenchContext.Provider value={api}>{children}</WorkbenchContext.Provider>;
}

export function useWorkbench(): WorkbenchApi {
  const api = useContext(WorkbenchContext);
  if (!api) throw new Error("useWorkbench outside WorkbenchProvider");
  return api;
}
