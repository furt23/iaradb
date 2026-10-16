"use client";

import type { CellOutput, TableInfo } from "@iara/protocol";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";

import type { ActionResult } from "@/server/result";
import { catalogSchema, previewTable, tableInfo } from "@/server/actions/catalog";

import { tableFromPathname, tableHref } from "./links";
import { dataTabsReducer, emptyDataTabs, parseDataTabs, type DataTabs, type DataTabsAction } from "./dataTabsState";

const STORAGE_KEY = "iara.dataTabs.v1";

export type Load<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "failed"; type: string; message: string };
export type Columns = Record<string, { name: string; type: string }[]>;

function restore(): DataTabs {
  if (typeof window === "undefined") return emptyDataTabs();
  try {
    return parseDataTabs(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null")) ?? emptyDataTabs();
  } catch {
    return emptyDataTabs();
  }
}

function settle<T>(r: ActionResult<T>): Load<T> {
  return r.ok ? { status: "ready", data: r.data } : { status: "failed", type: r.error.type, message: r.error.message };
}

export interface DataApi {
  tabs: DataTabs;
  /** Apply a tab action; on the Data pages the URL follows the active tab. */
  act(action: DataTabsAction): void;
  /** Show the table the URL names (no navigation). */
  follow(name: string): void;
  /** Go to the active table (from `/data`). */
  showActive(): void;
  info(name: string): Load<TableInfo> | undefined;
  preview(name: string): Load<CellOutput> | undefined;
  /** Load a table's statistics and sample (again, with `force`). */
  load(name: string, force?: boolean): void;
  /** Every table's columns (loaded on first use). */
  columns: Load<Columns> | null;
  loadColumns(force?: boolean): void;
  /** Forget what was loaded (the catalog changed). */
  invalidate(): void;
}

const DataContext = createContext<DataApi | null>(null);

/** Open table tabs and what was loaded about the tables, shared by the catalog panel and the Data pages. */
export function DataProvider({ children }: { children: ReactNode }) {
  const [tabs, dispatch] = useReducer(dataTabsReducer, undefined, restore);
  const tabsRef = useRef(tabs);
  const [infos, setInfos] = useState<Record<string, Load<TableInfo>>>({});
  const [previews, setPreviews] = useState<Record<string, Load<CellOutput>>>({});
  const [columns, setColumns] = useState<Load<Columns> | null>(null);
  const columnsRef = useRef<Load<Columns> | null>(null);
  /** tables loaded or loading */
  const requested = useRef(new Set<string>());
  const pathname = usePathname();
  const router = useRouter();
  const onData = pathname === "/data" || pathname.startsWith("/data/");
  const route = useRef({ pathname, onData });
  route.current = { pathname, onData };

  useEffect(() => {
    tabsRef.current = tabs;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
    } catch {
      // storage unavailable: tabs are not remembered
    }
  }, [tabs]);

  const navigate = useCallback(
    (next: DataTabs) => {
      if (next.active === tableFromPathname(route.current.pathname)) return;
      router.push(tableHref(next.active));
    },
    [router],
  );

  const act = useCallback(
    (action: DataTabsAction) => {
      const next = dataTabsReducer(tabsRef.current, action);
      if (next === tabsRef.current) return;
      tabsRef.current = next;
      dispatch(action);
      if (route.current.onData) navigate(next);
    },
    [navigate],
  );

  const follow = useCallback((name: string) => {
    const next = dataTabsReducer(tabsRef.current, { type: "open", name });
    if (next === tabsRef.current) return;
    tabsRef.current = next;
    dispatch({ type: "open", name });
  }, []);

  const showActive = useCallback(() => {
    if (tabsRef.current.active) navigate(tabsRef.current);
  }, [navigate]);

  const load = useCallback((name: string, force = false) => {
    if (requested.current.has(name) && !force) return;
    requested.current.add(name);
    setInfos((m) => ({ ...m, [name]: { status: "loading" } }));
    setPreviews((m) => ({ ...m, [name]: { status: "loading" } }));
    // statistics first (they are quick), then the sample
    void tableInfo(name)
      .then((r) => setInfos((m) => ({ ...m, [name]: settle(r) })))
      .then(() => previewTable(name))
      .then((r) => setPreviews((m) => ({ ...m, [name]: settle(r) })));
  }, []);

  const loadColumns = useCallback((force = false) => {
    const current = columnsRef.current;
    if (current && !force && current.status !== "failed") return;
    const set = (c: Load<Columns> | null) => {
      columnsRef.current = c;
      setColumns(c);
    };
    set({ status: "loading" });
    void catalogSchema().then((r) => set(settle(r)));
  }, []);

  const invalidate = useCallback(() => {
    requested.current.clear();
    columnsRef.current = null;
    setInfos({});
    setPreviews({});
    setColumns(null);
  }, []);

  const api = useMemo<DataApi>(
    () => ({
      tabs,
      act,
      follow,
      showActive,
      info: (name) => infos[name],
      preview: (name) => previews[name],
      load,
      columns,
      loadColumns,
      invalidate,
    }),
    [tabs, act, follow, showActive, infos, previews, load, columns, loadColumns, invalidate],
  );
  return <DataContext.Provider value={api}>{children}</DataContext.Provider>;
}

export function useData(): DataApi {
  const api = useContext(DataContext);
  if (!api) throw new Error("useData outside DataProvider");
  return api;
}
