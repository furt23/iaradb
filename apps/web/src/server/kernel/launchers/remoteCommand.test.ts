import { describe, expect, it } from "vitest";

import { remoteCommand } from "./remoteCommand";
import { quotePath, shellQuote } from "./shellQuote";

const machine = { user: "iara", home: "/home/iara", python: "/home/iara/venv/bin/python", workspace: "/home/iara/workspace" };

describe("remote kernel command", () => {
  it("quotes values and keeps ~/ expandable", () => {
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
    expect(quotePath("~/a b/c")).toBe(`~/'a b/c'`);
    expect(quotePath("/opt/x")).toBe(`'/opt/x'`);
  });

  it("runs the kernel as the unprivileged user, with its environment", () => {
    const cmd = remoteCommand({ ...machine, env: { IARA_MEMORY_LIMIT: "6442450944" } });
    expect(cmd).toBe(
      "exec sudo -n -u iara -H env -C '/home/iara' PYTHONUNBUFFERED='1' PYTHONIOENCODING='utf-8' IARA_MEMORY_LIMIT='6442450944' '/home/iara/venv/bin/python' -m iara.kernel --workspace '/home/iara/workspace' --create",
    );
  });

  it("refuses environment names that could inject commands", () => {
    expect(() => remoteCommand({ ...machine, env: { "A;B": "1" } })).toThrow(/invalid environment/);
    expect(remoteCommand({ ...machine, env: { X: "$(boom)" } })).toContain(`X='$(boom)'`);
  });

  it("refuses user names that could inject commands", () => {
    expect(() => remoteCommand({ ...machine, user: "iara; id" })).toThrow(/invalid user/);
    expect(() => remoteCommand({ ...machine, user: "" })).toThrow(/invalid user/);
  });
});
