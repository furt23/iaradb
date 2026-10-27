/**
 * The first-boot script of a cluster machine (pure; unit tested): the
 * Studio's SSH key, the engine wheel from the artifacts bucket, the users
 * that kernels (and the team bucket's proxy) run as, a Python venv, an idle
 * watchdog and a hard time limit. The machine terminates on shutdown, so both
 * limits end its billing.
 *
 * Kernels run as `iara`, who has no sudo and cannot reach the instance metadata
 * service (so the machine's role is not theirs). The team bucket's keys belong
 * to `iara-proxy`, who runs the S3 proxy; see storage/bucketProxy.ts.
 */

import { LIBRARY_SPEC } from "./clusterSettings";

export const READY_MARKER = "/var/lib/iara/ready";
/** the user kernels run as (SSH logs in as ec2-user, who has sudo, and starts them with `sudo -u`) */
export const KERNEL_USER = "iara";
export const KERNEL_HOME = `/home/${KERNEL_USER}`;
export const VENV = `${KERNEL_HOME}/venv`;
export const UV = `${KERNEL_HOME}/.local/bin/uv`;
/** the kernels' working directory */
export const WORKSPACE_DIR = `${KERNEL_HOME}/workspace`;
/** spill files and large results: on the EBS volume (AL2023's /tmp is in RAM) */
export const SPILL_DIR = `${KERNEL_HOME}/.iara/spill`;
/** the engine's disk cache of remote object reads (also on the EBS volume) */
export const DISK_CACHE_DIR = `${KERNEL_HOME}/.iara/cache`;
/** the boot script writes why it failed here (the Studio reads it) */
export const FAILED_MARKER = "/var/lib/iara/failed";
export const INIT_LOG = "/var/log/iara-init.log";
export const BOOT_LOG = "/var/log/cloud-init-output.log";
export const ENV_FILE = "/etc/iara/env";
export const PACKAGES = ["pyarrow", "marimo", "jedi"];

/** the team bucket's proxy: its user, systemd unit, binary, address and the file with the bucket's keys */
export const PROXY_USER = "iara-proxy";
export const PROXY_SERVICE = "iara-s3-proxy";
export const PROXY_BINARY = "/usr/local/bin/iara-s3-proxy";
export const PROXY_LISTEN = "127.0.0.1:9000";
export const PROXY_KEYS_FILE = "/etc/iara/r2.json";
/** machines are x86_64, as the engine wheel is (python/iara/cloud/publish.py builds both) */
export const PROXY_ARCH = "x86_64";

/** The kernels' disk cache settings on a cluster with a `volumeGb` GB volume: a quarter of it. */
export function diskCacheEnv(volumeGb: number): Record<string, string> {
  return { IARA_DISK_CACHE_DIR: DISK_CACHE_DIR, IARA_DISK_CACHE_MB: String(Math.floor((volumeGb * 1024) / 4)) };
}

/** Where the proxy binary is, from the engine wheel's URL: the same folder of the artifacts bucket. */
export function proxyUrlOf(wheelUrl: string): string {
  return `${wheelUrl.slice(0, wheelUrl.lastIndexOf("/") + 1)}iara-s3-proxy-${PROXY_ARCH}`;
}

export interface TeamBucket {
  bucket: string;
  /** the bucket's S3 endpoint (the proxy sends its requests there) */
  endpoint: string;
  region: string;
}

export interface ProxyInput extends TeamBucket {
  /** s3://bucket/engine/<version>/iara-s3-proxy-<arch> */
  url: string;
}

export interface UserDataInput {
  /** OpenSSH public key line of the Studio's identity */
  authorizedKey: string;
  /** s3://bucket/engine/<version>/<wheel> */
  wheelUrl: string;
  /** the team bucket's proxy, installed but not started (null: the Studio has no team bucket) */
  proxy: ProxyInput | null;
  /** power off after this many minutes without kernels nor SSH sessions */
  idleMinutes: number;
  /** power off after this many minutes whatever happens */
  maxMinutes: number;
  region: string;
  /** pip requirement specs, installed with the engine */
  libraries: string[];
  /** bash run as the kernel user (not root: no system packages) after the libraries ("" for none) */
  initScript: string;
  /** written to ENV_FILE for the init script to source */
  env: Record<string, string>;
}

const SAFE = /^[A-Za-z0-9+/=@:._\- ]+$/;
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{1,32}$/;
const ENDPOINT = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~/-]*)?$/;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checked(name: string, value: string): string {
  if (!SAFE.test(value)) throw new Error(`unsafe ${name} for the boot script`);
  return value;
}

function matching(name: string, value: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new Error(`unsafe ${name} for the boot script`);
  return value;
}

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

/** `export NAME='value'` lines (values single-quoted, quotes escaped). */
function envFile(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([name, value]) => {
      if (!ENV_NAME.test(name)) throw new Error("unsafe environment variable name for the boot script");
      return `export ${name}='${value.replaceAll("'", "'\\''")}'\n`;
    })
    .join("");
}

/**
 * Runs the init script as the kernel user (no sudo: it cannot change the system) with the environment sourced;
 * a failure stops the boot with its own message.
 */
function initStep(script: string): string {
  if (script === "") return "";
  return `echo '${b64(script)}' | base64 -d > /var/lib/iara/init.sh
if ! sudo -u ${KERNEL_USER} -H bash -lc 'cd; set -a; . ${ENV_FILE}; set +a; bash /var/lib/iara/init.sh' > ${INIT_LOG} 2>&1; then
  trap - ERR
  echo "the init script failed: see the Init script log" > ${FAILED_MARKER}
  exit 1
fi
`;
}

/**
 * The kernel user, the proxy's user, and a firewall rule that keeps both away from the instance metadata
 * service (which would hand them the machine's role). The boot stops if the service is still reachable.
 */
function users(): string {
  return `useradd --create-home --shell /bin/bash ${KERNEL_USER}
chmod 700 ${KERNEL_HOME}
useradd --system --no-create-home --shell /usr/sbin/nologin ${PROXY_USER}
install -d -m 755 /etc/iara
command -v nft >/dev/null || dnf install -y -q nftables
nft add table inet iara
nft add chain inet iara out '{ type filter hook output priority 0; policy accept; }'
for u in ${KERNEL_USER} ${PROXY_USER}; do
  nft add rule inet iara out meta skuid "$(id -u $u)" ip daddr 169.254.169.254 reject
  nft add rule inet iara out meta skuid "$(id -u $u)" ip6 daddr fd00:ec2::254 reject
done
if sudo -u ${KERNEL_USER} curl -s -o /dev/null -m 3 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 10' http://169.254.169.254/latest/api/token; then
  trap - ERR
  echo "the instance metadata service is reachable by the kernel user" > ${FAILED_MARKER}
  exit 1
fi`;
}

/**
 * The team bucket's proxy: its binary (from the artifacts bucket, root-owned) and a systemd unit that is not started
 * here, since the keys are not on the machine: Studio writes them over SSH and starts it.
 */
function proxy(p: ProxyInput | null, region: string): string {
  if (!p) return "";
  const url = checked("proxy url", p.url);
  const endpoint = matching("bucket endpoint", p.endpoint, ENDPOINT);
  const bucket = matching("bucket name", p.bucket, BUCKET_NAME);
  const bucketRegion = matching("bucket region", p.region, REGION);
  return `aws s3 cp --only-show-errors --region ${region} '${url}' ${PROXY_BINARY}
chown root:root ${PROXY_BINARY} && chmod 755 ${PROXY_BINARY}
cat > /etc/systemd/system/${PROXY_SERVICE}.service <<'EOF'
[Unit]
Description=Iara S3 proxy for the team bucket
After=network.target

[Service]
User=${PROXY_USER}
ExecStart=${PROXY_BINARY} --listen ${PROXY_LISTEN} --endpoint ${endpoint} --bucket ${bucket} --region ${bucketRegion} --keys-file ${PROXY_KEYS_FILE}
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/iara
PrivateTmp=true
EOF
systemctl daemon-reload
`;
}

/** Shuts the machine down after `idle` minutes without a kernel process or an SSH session. */
function watchdog(idleMinutes: number): string {
  return `cat > /usr/local/bin/iara-idle <<'EOF'
#!/bin/bash
stamp=/run/iara-last-active
if pgrep -f iara.kernel >/dev/null || [ -n "$(ss -Htn state established '( sport = :22 )')" ] || [ ! -f "$stamp" ]; then
  touch "$stamp"; exit 0
fi
idle=$(( $(date +%s) - $(stat -c %Y "$stamp") ))
if [ "$idle" -ge ${idleMinutes * 60} ]; then shutdown -h now "iara: idle"; fi
EOF
chmod +x /usr/local/bin/iara-idle
cat > /etc/systemd/system/iara-idle.service <<'EOF'
[Service]
Type=oneshot
ExecStart=/usr/local/bin/iara-idle
EOF
cat > /etc/systemd/system/iara-idle.timer <<'EOF'
[Timer]
OnBootSec=5min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload && systemctl enable --now iara-idle.timer`;
}

export function userData(input: UserDataInput): string {
  const key = checked("ssh key", input.authorizedKey.trim());
  const wheel = checked("wheel url", input.wheelUrl);
  const region = checked("region", input.region);
  const libraries = input.libraries.map((l) => {
    if (!LIBRARY_SPEC.test(l)) throw new Error("unsafe library for the boot script");
    return `'${l}'`;
  });
  const wheelFile = `/tmp/${wheel.slice(wheel.lastIndexOf("/") + 1)}`;
  return `#!/bin/bash
set -euxo pipefail
mkdir -p /var/lib/iara
trap 'echo "boot failed at line $LINENO: see the Boot log" > ${FAILED_MARKER}' ERR
# hard limit: the machine terminates whatever happens
shutdown -h +${Math.max(10, Math.floor(input.maxMinutes))} "iara: time limit"
install -d -m 700 -o ec2-user -g ec2-user /home/ec2-user/.ssh
echo '${key}' >> /home/ec2-user/.ssh/authorized_keys
chown ec2-user:ec2-user /home/ec2-user/.ssh/authorized_keys && chmod 600 /home/ec2-user/.ssh/authorized_keys
${watchdog(Math.max(1, Math.floor(input.idleMinutes)))}
${users()}
aws s3 cp --only-show-errors --region ${region} '${wheel}' '${wheelFile}'
chmod 644 '${wheelFile}'
${proxy(input.proxy, region)}sudo -u ${KERNEL_USER} -H bash -lc 'curl -LsSf https://astral.sh/uv/install.sh | sh'
sudo -u ${KERNEL_USER} -H mkdir -p ${WORKSPACE_DIR} ${SPILL_DIR}
sudo -u ${KERNEL_USER} -H mkdir -p -m 700 ${DISK_CACHE_DIR}
sudo -u ${KERNEL_USER} -H bash -lc "${UV} venv -q --python 3.12 ${VENV} && ${UV} pip install -q --python ${VENV}/bin/python ${[wheelFile, ...PACKAGES, ...libraries].join(" ")}"
mkdir -p /etc/iara && echo '${b64(envFile(input.env))}' | base64 -d > ${ENV_FILE}
${initStep(input.initScript)}touch ${READY_MARKER}
`;
}
