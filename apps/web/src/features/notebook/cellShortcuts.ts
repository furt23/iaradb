import { isModKey } from "@/features/shell/ShellProvider";

export type CellShortcut = "runAbove" | "runBelow" | "stop" | "find";

/**
 * Notebook keys (Ctrl, or Cmd on Apple keyboards). Shift+Enter and Ctrl+Enter
 * run the cell itself (see CodeEditor). Ctrl+Shift+Enter runs the cells above,
 * Ctrl+Alt+Enter runs the cell and the cells below, Ctrl+. stops, Ctrl+F finds.
 */
export function cellShortcut(e: KeyboardEvent): CellShortcut | null {
  if (e.repeat || !isModKey(e)) return null;
  if (e.key === "." && !e.shiftKey && !e.altKey) return "stop";
  if (e.key.toLowerCase() === "f" && !e.shiftKey && !e.altKey) return "find";
  if (e.key !== "Enter") return null;
  if (e.shiftKey && !e.altKey) return "runAbove";
  if (e.altKey && !e.shiftKey) return "runBelow";
  return null;
}
