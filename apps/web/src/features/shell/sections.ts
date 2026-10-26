/** The Studio's sections (the navigation rail) and which side panel each shows (pure). */

export type SectionId = "workspace" | "data" | "wrangle" | "dashboards" | "sql" | "history" | "jobs" | "compute" | "git";
/** the side panel of a section, if it has one */
export type PanelId = "files" | "catalog";

export interface Section {
  id: SectionId;
  href: string;
  label: string;
  panel: PanelId | null;
}

export const SECTIONS: Section[] = [
  { id: "workspace", href: "/notebooks", label: "Workspace", panel: "files" },
  { id: "data", href: "/data", label: "Data", panel: "catalog" },
  { id: "wrangle", href: "/wrangle", label: "Wrangler", panel: "catalog" },
  { id: "dashboards", href: "/dashboards", label: "Dashboards", panel: null },
  { id: "sql", href: "/sql", label: "SQL editor", panel: null },
  { id: "history", href: "/history", label: "Query history", panel: null },
  { id: "jobs", href: "/jobs", label: "Jobs", panel: null },
  { id: "compute", href: "/compute", label: "Compute", panel: null },
  { id: "git", href: "/git", label: "Git", panel: null },
];

const PREFIXES: [string, SectionId][] = [
  ["/notebooks", "workspace"],
  ["/queries", "workspace"],
  ["/files", "workspace"],
  ["/data", "data"],
  ["/catalog", "data"],
  ["/wrangle", "wrangle"],
  ["/dashboards", "dashboards"],
  ["/sql", "sql"],
  ["/history", "history"],
  ["/analyze", "history"],
  ["/jobs", "jobs"],
  ["/compute", "compute"],
  ["/git", "git"],
];

export function sectionOf(pathname: string): SectionId {
  if (pathname === "/") return "workspace";
  for (const [prefix, id] of PREFIXES) if (pathname === prefix || pathname.startsWith(prefix + "/")) return id;
  return "workspace";
}

export function section(id: SectionId): Section {
  return SECTIONS.find((s) => s.id === id) ?? SECTIONS[0];
}
