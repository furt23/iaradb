import { describe, expect, it } from "vitest";

import { remoteCommand } from "./remoteCommand";
import { quotePath, shellQuote } from "./shellQuote";

describe("remote kernel command", () => {
  it("quotes values and keeps ~/ expandable", () => {
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
    expect(quotePath("~/a b/c")).toBe(`~/'a b/c'`);
    expect(quotePath("/opt/x")).toBe(`'/opt/x'`);
  });

  it("runs the kernel with its environment", () => {
    const cmd = remoteCommand({ python: "/home/ec2-user/venv/bin/python", workspace: "~/workspace", env: { WORKHOUSE_MEMORY_LIMIT: "6442450944" } });
    expect(cmd).toBe(
      "exec env PYTHONUNBUFFERED='1' PYTHONIOENCODING='utf-8' WORKHOUSE_MEMORY_LIMIT='6442450944' '/home/ec2-user/venv/bin/python' -m workhouse.kernel --workspace ~/'workspace' --create",
    );
  });

  it("refuses environment names that could inject commands", () => {
    expect(() => remoteCommand({ python: "p", workspace: "w", env: { "A;B": "1" } })).toThrow(/invalid environment/);
    expect(remoteCommand({ python: "p", workspace: "w", env: { X: "$(boom)" } })).toContain(`X='$(boom)'`);
  });
});
