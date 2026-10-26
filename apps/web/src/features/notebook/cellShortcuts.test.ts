import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cellShortcut } from "./cellShortcuts";

const press = (init: Partial<KeyboardEvent>) => ({ key: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, ...init }) as KeyboardEvent;

describe("cell run keys", () => {
  beforeEach(() => vi.stubGlobal("navigator", { platform: "Win32" }));
  afterEach(() => vi.unstubAllGlobals());

  it("maps Ctrl+Shift+Enter to the cells above, Ctrl+Alt+Enter to this cell and below, Ctrl+. to stop", () => {
    expect(cellShortcut(press({ key: "Enter", ctrlKey: true, shiftKey: true }))).toBe("runAbove");
    expect(cellShortcut(press({ key: "Enter", ctrlKey: true, altKey: true }))).toBe("runBelow");
    expect(cellShortcut(press({ key: ".", ctrlKey: true }))).toBe("stop");
  });

  it("maps Ctrl+F, in either case, to find", () => {
    expect(cellShortcut(press({ key: "f", ctrlKey: true }))).toBe("find");
    expect(cellShortcut(press({ key: "F", ctrlKey: true }))).toBe("find");
    expect(cellShortcut(press({ key: "f" }))).toBeNull();
    expect(cellShortcut(press({ key: "f", ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it("leaves the keys that run this cell, and held-down repeats, to the editor", () => {
    expect(cellShortcut(press({ key: "Enter" }))).toBeNull();
    expect(cellShortcut(press({ key: "Enter", shiftKey: true }))).toBeNull();
    expect(cellShortcut(press({ key: "Enter", ctrlKey: true }))).toBeNull();
    expect(cellShortcut(press({ key: "Enter", ctrlKey: true, shiftKey: true, repeat: true }))).toBeNull();
  });

  it("uses Cmd instead of Ctrl on Apple keyboards", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    expect(cellShortcut(press({ key: "Enter", metaKey: true, shiftKey: true }))).toBe("runAbove");
    expect(cellShortcut(press({ key: "Enter", ctrlKey: true, shiftKey: true }))).toBeNull();
  });
});
