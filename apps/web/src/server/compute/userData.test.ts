import { describe, expect, it } from "vitest";

import { DISK_CACHE_DIR, diskCacheEnv, PROXY_ARCH, proxyUrlOf, READY_MARKER, SPILL_DIR, userData, VENV } from "./userData";

const wheelUrl = "s3://iara-artifacts-123456789012-us-east-1/engine/0.1.0/iara-0.1.0-cp310-abi3-manylinux_2_28_x86_64.whl";

const input = {
  authorizedKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK0+abc iara-studio",
  wheelUrl,
  proxy: null,
  idleMinutes: 15,
  maxMinutes: 720,
  region: "us-east-1",
  libraries: [],
  initScript: "",
  env: {},
};

const proxy = {
  url: proxyUrlOf(wheelUrl),
  endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  bucket: "team-data",
  region: "auto",
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

  it("runs kernels as an unprivileged user with the venv, spill folder and workspace in its home", () => {
    expect(VENV).toBe("/home/iara/venv");
    expect(SPILL_DIR).toBe("/home/iara/.iara/spill");
    expect(script).toContain("useradd --create-home --shell /bin/bash iara\n");
    expect(script).toContain("chmod 700 /home/iara");
    expect(script).toContain("sudo -u iara -H mkdir -p /home/iara/workspace /home/iara/.iara/spill");
    // the disk cache folder belongs to the kernel user and nobody else can open it
    expect(script).toContain("sudo -u iara -H mkdir -p -m 700 /home/iara/.iara/cache");
    expect(script).toContain(`sudo -u iara -H bash -lc "/home/iara/.local/bin/uv venv -q --python 3.12 /home/iara/venv && /home/iara/.local/bin/uv pip install -q --python /home/iara/venv/bin/python /tmp/iara-0.1.0-cp310-abi3-manylinux_2_28_x86_64.whl pyarrow marimo jedi"`);
    expect(script).toContain(`sudo -u iara -H bash -lc 'curl -LsSf https://astral.sh/uv/install.sh | sh'`);
    // no sudo for the kernel user, and nothing of the engine under the SSH user
    expect(script).not.toMatch(/\bwheel\b|sudoers|usermod|--groups/);
    expect(script).not.toContain("/home/ec2-user/venv");
    expect(script).not.toContain("sudo -u ec2-user");
  });

  it("gives kernels a disk cache of a quarter of the volume", () => {
    expect(DISK_CACHE_DIR).toBe("/home/iara/.iara/cache");
    expect(diskCacheEnv(40)).toEqual({ IARA_DISK_CACHE_DIR: "/home/iara/.iara/cache", IARA_DISK_CACHE_MB: "10240" });
    expect(diskCacheEnv(100).IARA_DISK_CACHE_MB).toBe("25600");
    expect(diskCacheEnv(2000).IARA_DISK_CACHE_MB).toBe("512000");
    expect(diskCacheEnv(21).IARA_DISK_CACHE_MB).toBe("5376");
  });

  it("keeps the kernel user and the proxy user away from the instance metadata service", () => {
    expect(script).toContain("useradd --system --no-create-home --shell /usr/sbin/nologin iara-proxy");
    expect(script).toContain("command -v nft >/dev/null || dnf install -y -q nftables");
    expect(script).toContain("nft add table inet iara");
    expect(script).toContain(`nft add chain inet iara out '{ type filter hook output priority 0; policy accept; }'`);
    expect(script).toContain("for u in iara iara-proxy; do");
    expect(script).toContain(`nft add rule inet iara out meta skuid "$(id -u $u)" ip daddr 169.254.169.254 reject`);
    expect(script).toContain(`nft add rule inet iara out meta skuid "$(id -u $u)" ip6 daddr fd00:ec2::254 reject`);
    // the boot fails if the service can still be reached, and the rule is in place before any kernel-user process of the engine install
    expect(script).toContain("if sudo -u iara curl -s -o /dev/null -m 3 -X PUT");
    expect(script).toContain("the instance metadata service is reachable by the kernel user");
    expect(script.indexOf("nft add table")).toBeLessThan(script.indexOf("uv/install.sh"));
  });

  it("marks failures and installs libraries with the engine", () => {
    const withLibs = userData({ ...input, libraries: ["polars==1.9", "pandas[parquet]"] });
    expect(withLibs).toContain(`trap 'echo "boot failed at line $LINENO: see the Boot log" > /var/lib/iara/failed' ERR`);
    expect(withLibs.indexOf("set -euxo pipefail")).toBeLessThan(withLibs.indexOf("trap "));
    expect(withLibs).toContain(`pyarrow marimo jedi 'polars==1.9' 'pandas[parquet]'"`);
    expect(script).not.toContain("iara-init.log");
  });

  it("writes the environment and the init script only as base64, and runs the script as the kernel user", () => {
    const env = { TOKEN: "it's $(whoami)" };
    const initScript = "echo $SECRET; rm -rf /";
    const out = userData({ ...input, env, initScript });
    const b64 = (t: string) => Buffer.from(t).toString("base64");
    expect(out).toContain(`echo '${b64("export TOKEN='it'\\''s $(whoami)'\n")}' | base64 -d > /etc/iara/env`);
    expect(out).toContain(`echo '${b64(initScript)}' | base64 -d > /var/lib/iara/init.sh`);
    expect(out).toContain(
      "if ! sudo -u iara -H bash -lc 'cd; set -a; . /etc/iara/env; set +a; bash /var/lib/iara/init.sh' > /var/log/iara-init.log 2>&1; then",
    );
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

describe("team bucket proxy in the boot script", () => {
  it("installs nothing without a team bucket", () => {
    const script = userData(input);
    expect(script).not.toContain("iara-s3-proxy");
    expect(script).not.toContain("r2.json");
  });

  it("finds the binary next to the wheel", () => {
    expect(PROXY_ARCH).toBe("x86_64");
    expect(proxyUrlOf(wheelUrl)).toBe("s3://iara-artifacts-123456789012-us-east-1/engine/0.1.0/iara-s3-proxy-x86_64");
  });

  const script = userData({ ...input, proxy });

  it("downloads the binary as root and defines its unit under its own user", () => {
    expect(script).toContain(`aws s3 cp --only-show-errors --region us-east-1 '${proxy.url}' /usr/local/bin/iara-s3-proxy`);
    expect(script).toContain("chown root:root /usr/local/bin/iara-s3-proxy && chmod 755 /usr/local/bin/iara-s3-proxy");
    const unit = /cat > \/etc\/systemd\/system\/iara-s3-proxy\.service <<'EOF'\n([\s\S]*?)\nEOF/.exec(script)?.[1] ?? "";
    expect(unit).toContain("User=iara-proxy");
    expect(unit).toContain(
      `ExecStart=/usr/local/bin/iara-s3-proxy --listen 127.0.0.1:9000 --endpoint ${proxy.endpoint} --bucket team-data --region auto --keys-file /etc/iara/r2.json`,
    );
    for (const line of ["Restart=on-failure", "NoNewPrivileges=true", "ProtectSystem=strict", "ReadOnlyPaths=/etc/iara", "PrivateTmp=true"]) {
      expect(unit).toContain(line);
    }
    expect(script).toContain("systemctl daemon-reload\n");
  });

  it("does not start the proxy, and carries no keys", () => {
    expect(script).not.toMatch(/systemctl (enable|start|restart)[^\n]*iara-s3-proxy/);
    expect(script).not.toMatch(/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|access_key_id|secret_access_key/);
    expect(script).not.toContain("> /etc/iara/r2.json");
  });

  it("refuses settings that would break out of the unit", () => {
    expect(() => userData({ ...input, proxy: { ...proxy, bucket: "b --keys-file /etc/passwd" } })).toThrow(/unsafe bucket name/);
    expect(() => userData({ ...input, proxy: { ...proxy, endpoint: "https://e.example.com --x" } })).toThrow(/unsafe bucket endpoint/);
    expect(() => userData({ ...input, proxy: { ...proxy, endpoint: "ftp://e.example.com" } })).toThrow(/unsafe bucket endpoint/);
    expect(() => userData({ ...input, proxy: { ...proxy, region: "auto\nUser=root" } })).toThrow(/unsafe bucket region/);
    expect(() => userData({ ...input, proxy: { ...proxy, url: "s3://b/$(boom)" } })).toThrow(/unsafe proxy url/);
  });
});
