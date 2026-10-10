/** Catalog tables open as tabs, one strip, no panes (pure). */

export interface DataTabs {
  /** table names, in tab order */
  tabs: string[];
  active: string | null;
}

export type DataTabsAction =
  /** open (or show) a table, next to the active tab */
  | { type: "open"; name: string }
  | { type: "close"; name: string }
  | { type: "closeOthers"; name: string }
  | { type: "closeAll" }
  /** only tables still in the catalog keep their tabs */
  | { type: "keep"; names: string[] }
  | { type: "reorder"; name: string; over: string };

export function emptyDataTabs(): DataTabs {
  return { tabs: [], active: null };
}

function withoutTab(s: DataTabs, name: string): DataTabs {
  const i = s.tabs.indexOf(name);
  if (i < 0) return s;
  const tabs = s.tabs.filter((t) => t !== name);
  return { tabs, active: s.active === name ? (tabs[Math.min(i, tabs.length - 1)] ?? null) : s.active };
}

export function dataTabsReducer(s: DataTabs, a: DataTabsAction): DataTabs {
  switch (a.type) {
    case "open": {
      if (s.tabs.includes(a.name)) return s.active === a.name ? s : { ...s, active: a.name };
      const at = s.active ? s.tabs.indexOf(s.active) + 1 : s.tabs.length;
      const tabs = [...s.tabs];
      tabs.splice(at, 0, a.name);
      return { tabs, active: a.name };
    }
    case "close":
      return withoutTab(s, a.name);
    case "closeOthers":
      return s.tabs.includes(a.name) ? { tabs: [a.name], active: a.name } : s;
    case "closeAll":
      return emptyDataTabs();
    case "keep": {
      const names = new Set(a.names);
      const gone = s.tabs.filter((t) => !names.has(t));
      return gone.reduce(withoutTab, s);
    }
    case "reorder": {
      const from = s.tabs.indexOf(a.name);
      const to = s.tabs.indexOf(a.over);
      if (from < 0 || to < 0 || from === to) return s;
      const tabs = [...s.tabs];
      tabs.splice(to, 0, ...tabs.splice(from, 1));
      return { ...s, tabs };
    }
  }
}

/** Stored tabs, if well-formed. */
export function parseDataTabs(value: unknown): DataTabs | null {
  const v = value as Partial<DataTabs> | null;
  if (!v || !Array.isArray(v.tabs)) return null;
  const tabs = [...new Set(v.tabs.filter((t): t is string => typeof t === "string"))];
  const active = typeof v.active === "string" && tabs.includes(v.active) ? v.active : (tabs[0] ?? null);
  return { tabs, active };
}
