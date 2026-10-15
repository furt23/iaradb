"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";

import { drafts, dropDrafts, renameDrafts } from "@/features/queries/drafts";

import { fileFromPathname, fileHref, renameFileIds, setFileIds } from "./fileIdRegistry";
import { dropRecent, parseRecent, renameRecent, touchRecent } from "./recent";
import { activePath, emptyWorkbench, parseWorkbench, workbenchReducer, type WorkbenchAction, type WorkbenchState } from "./workbenchState";

const STORAGE_KEY = "iara.workbench.v1";
const RECENT_KEY = "iara.recent.v1";

// URLs name files by id (see fileIdRegistry); callers import these from here
export { fileFromPathname, fileHref };

function isWorkbenchRoute(pathname: string): boolean {
  return pathname === "/notebooks" || pathname.startsWith("/notebooks/") || pathname.startsWith("/queries/");
}

function restoreRecent(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return parseRecent(JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "null"));
  } catch {
    return [];
  }
}

/** How an action changes the recent files. */
function recentAfter(recent: string[], action: WorkbenchAction): string[] {
  switch (action.type) {
    case "open":
    case "openToSide":
      return touchRecent(recent, action.path);
    case "rename":
      return renameRecent(recent, action.from, action.to);
    case "closeWithin":
    case "closePath":
      return dropRecent(recent, action.path);
    default:
      return recent;
  }
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
  /** recently opened files, most recent first */
  recent: string[];
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

/**
 * The open notebook tabs and panes, shared by the file tree and the workbench.
 * `ids` maps each notebook and SQL file to the id its URL names.
 */
export function WorkbenchProvider({ children, ids }: { children: ReactNode; ids: Record<string, string> }) {
  // known before anything renders a link; a new `ids` (after a refresh) replaces it
  useMemo(() => setFileIds(ids), [ids]);
  // read on the client's first render: nothing renders from it before mount
  const [state, dispatch] = useReducer(workbenchReducer, undefined, restore);
  const stateRef = useRef(state);
  const [recent, setRecent] = useReducer(recentAfter, undefined, restoreRecent);
  const pathname = usePathname();
  const router = useRouter();
  const visible = isWorkbenchRoute(pathname);
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

  useEffect(() => {
    try {
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch {
      // storage unavailable: recent files are not remembered
    }
  }, [recent]);

  const navigate = useCallback(
    (next: WorkbenchState, push: boolean) => {
      const target = activePath(next);
      if (target === fileFromPathname(route.current.pathname) && route.current.visible) return;
      const href = target ? fileHref(target) : "/notebooks";
      if (push) router.push(href);
      else router.replace(href);
    },
    [router],
  );

  const act = useCallback(
    (action: WorkbenchAction, reveal = false) => {
      const next = workbenchReducer(stateRef.current, action);
      stateRef.current = next;
      // a renamed file keeps its id, so its URL stays the same
      if (action.type === "rename") renameFileIds(action.from, action.to);
      dispatch(action);
      setRecent(action);
      // unsaved SQL text follows its file (its tab remounts under the new path)
      if (action.type === "rename") renameDrafts(drafts, action.from, action.to);
      else if (action.type === "closeWithin" || action.type === "closePath") dropDrafts(drafts, action.path);
      if (reveal || route.current.visible) navigate(next, reveal);
    },
    [navigate],
  );

  const follow = useCallback((path: string) => {
    const next = workbenchReducer(stateRef.current, { type: "open", path });
    setRecent({ type: "open", path });
    if (next === stateRef.current) return;
    stateRef.current = next;
    dispatch({ type: "open", path });
  }, []);

  const showFocused = useCallback(() => {
    if (activePath(stateRef.current)) navigate(stateRef.current, false);
  }, [navigate]);

  const api = useMemo(() => ({ state, recent, visible, act, follow, showFocused }), [state, recent, visible, act, follow, showFocused]);
  return <WorkbenchContext.Provider value={api}>{children}</WorkbenchContext.Provider>;
}

export function useWorkbench(): WorkbenchApi {
  const api = useContext(WorkbenchContext);
  if (!api) throw new Error("useWorkbench outside WorkbenchProvider");
  return api;
}
