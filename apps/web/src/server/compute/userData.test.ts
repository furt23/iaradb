import { describe, expect, it } from "vitest";

import { READY_MARKER, userData } from "./userData";

const input = {
  authorizedKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK0+abc iara-studio",
  wheelUrl: "s3://iara-artifacts-123456789012-us-east-1/engine/0.1.0/iara-0.1.0-cp310-abi3-manylinux_2_28_x86_64.whl",
  idleMinutes: 15,
  maxMinutes: 720,
  region: "us-east-1",
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

  it("refuses values that would break out of the script", () => {
    expect(() => userData({ ...input, authorizedKey: "ssh-ed25519 AAA'; rm -rf / #" })).toThrow(/unsafe/);
    expect(() => userData({ ...input, wheelUrl: "s3://b/$(boom).whl" })).toThrow(/unsafe/);
  });
});
