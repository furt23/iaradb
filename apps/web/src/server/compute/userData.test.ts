import { describe, expect, it } from "vitest";

import { READY_MARKER, userData } from "./userData";

const input = {
  authorizedKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK0+abc iara-studio",
  wheelUrl: "s3://iara-artifacts-123456789012-us-east-1/engine/0.1.0/iara-0.1.0-cp310-abi3-manylinux_2_28_x86_64.whl",
  idleMinutes: 15,
  maxMinutes: 720,
  region: "us-east-1",
  libraries: [],
  initScript: "",
  env: {},
};

describe("cluster boot script", () => {
  const script = userData(input);

  it("installs the Studio's key, the engine and the limits", () => {
    expect(script).toContain(`echo '${input.authorizedKey}' >> /home/ec2-user/.ssh/authorized_keys`);
    expect(script).toContain(`aws s3 cp --only-show-errors --region us-east-1 '${input.wheelUrl}'`);
    expect(script).toContain("shutdown -h +720");
    expect(script).toContain(`-ge ${15 * 60} ]`);
    expect(script).toContain("systemctl daemon-reload && systemctl enable --now iara-idle.timer");
    expect(script.trim().endsWith(`touch ${READY_MARKER}`)).toBe(true);
  });

  it("marks failures and installs libraries with the engine", () => {
    const withLibs = userData({ ...input, libraries: ["polars==1.9", "pandas[parquet]"] });
    expect(withLibs).toContain(`trap 'echo "boot failed at line $LINENO: see the Boot log" > /var/lib/iara/failed' ERR`);
    expect(withLibs.indexOf("set -euxo pipefail")).toBeLessThan(withLibs.indexOf("trap "));
    expect(withLibs).toContain(`pyarrow marimo jedi 'polars==1.9' 'pandas[parquet]'"`);
    expect(script).not.toContain("iara-init.log");
  });

  it("writes the environment and the init script only as base64", () => {
    const env = { TOKEN: "it's $(whoami)" };
    const initScript = "echo $SECRET; rm -rf /";
    const out = userData({ ...input, env, initScript });
    const b64 = (t: string) => Buffer.from(t).toString("base64");
    expect(out).toContain(`echo '${b64("export TOKEN='it'\\''s $(whoami)'\n")}' | base64 -d > /etc/iara/env`);
    expect(out).toContain(`echo '${b64(initScript)}' | base64 -d > /var/lib/iara/init.sh`);
    expect(out).toContain("(set -a; . /etc/iara/env; set +a; bash /var/lib/iara/init.sh) > /var/log/iara-init.log 2>&1");
    expect(out).not.toContain("whoami");
    expect(out).not.toContain("rm -rf");
    // the init failure message is written after the ERR trap is cleared, and before the ready marker
    expect(out.indexOf("trap - ERR")).toBeLessThan(out.indexOf("the init script failed"));
    expect(out.trim().endsWith(`touch ${READY_MARKER}`)).toBe(true);
  });

  it("refuses values that would break out of the script", () => {
    expect(() => userData({ ...input, authorizedKey: "ssh-ed25519 AAA'; rm -rf / #" })).toThrow(/unsafe/);
    expect(() => userData({ ...input, wheelUrl: "s3://b/$(boom).whl" })).toThrow(/unsafe/);
    expect(() => userData({ ...input, libraries: ["x'; rm -rf / #"] })).toThrow(/unsafe/);
    expect(() => userData({ ...input, env: { "A B": "1" } })).toThrow(/unsafe/);
  });
});
