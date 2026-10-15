/**
 * The first-boot script of a cluster machine (pure; unit tested): the
 * Studio's SSH key, the engine wheel from the artifacts bucket, a Python
 * venv, an idle watchdog and a hard time limit. The machine terminates on
 * shutdown, so both limits end its billing.
 */

export const READY_MARKER = "/var/lib/iara/ready";
export const VENV = "/home/ec2-user/venv";
/** spill files and large results: on the EBS volume (AL2023's /tmp is in RAM) */
export const SPILL_DIR = "/home/ec2-user/.iara/spill";
export const PACKAGES = ["pyarrow", "marimo", "jedi"];

export interface UserDataInput {
  /** OpenSSH public key line of the Studio's identity */
  authorizedKey: string;
  /** s3://bucket/engine/<version>/<wheel> */
  wheelUrl: string;
  /** power off after this many minutes without kernels nor SSH sessions */
  idleMinutes: number;
  /** power off after this many minutes whatever happens */
  maxMinutes: number;
  region: string;
}

const SAFE = /^[A-Za-z0-9+/=@:._\- ]+$/;

function checked(name: string, value: string): string {
  if (!SAFE.test(value)) throw new Error(`unsafe ${name} for the boot script`);
  return value;
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
  const wheelFile = `/tmp/${wheel.slice(wheel.lastIndexOf("/") + 1)}`;
  return `#!/bin/bash
set -euxo pipefail
# hard limit: the machine terminates whatever happens
shutdown -h +${Math.max(10, Math.floor(input.maxMinutes))} "iara: time limit"
install -d -m 700 -o ec2-user -g ec2-user /home/ec2-user/.ssh
echo '${key}' >> /home/ec2-user/.ssh/authorized_keys
chown ec2-user:ec2-user /home/ec2-user/.ssh/authorized_keys && chmod 600 /home/ec2-user/.ssh/authorized_keys
${watchdog(Math.max(1, Math.floor(input.idleMinutes)))}
aws s3 cp --only-show-errors --region ${checked("region", input.region)} '${wheel}' '${wheelFile}'
chmod 644 '${wheelFile}'
sudo -u ec2-user -H bash -lc 'curl -LsSf https://astral.sh/uv/install.sh | sh'
sudo -u ec2-user -H bash -lc '~/.local/bin/uv venv -q --python 3.12 ${VENV} && ~/.local/bin/uv pip install -q --python ${VENV}/bin/python ${wheelFile} ${PACKAGES.join(" ")}'
mkdir -p "$(dirname ${READY_MARKER})" && touch ${READY_MARKER}
`;
}
