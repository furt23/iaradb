import { operatorColors } from "@workhouse/ui";

/** Operator family of a plan node or pipeline step, for colors and icons. */
export function operatorFamily(name: string): keyof typeof operatorColors {
  const n = name.toLowerCase();
  if (n.includes("scan") || n.includes("materialized") || n.includes("values") || n.includes("memory")) return "scan";
  if (n.includes("join") || n.includes("probe") || n.includes("build")) return "join";
  if (n.includes("aggregate")) return "aggregate";
  if (n.includes("sort") || n.includes("topk")) return "sort";
  if (n.includes("filter")) return "filter";
  if (n.includes("window")) return "window";
  if (n.includes("recursive")) return "recursive";
  return "other";
}

export function operatorColor(name: string): string {
  return operatorColors[operatorFamily(name)];
}

/** `HashJoinProbe(Inner, build_rows=…)` -> `HashJoinProbe` */
export function operatorName(describe: string): string {
  return describe.split(/[([:]/)[0].trim();
}
