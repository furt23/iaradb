/** The shell command that starts a kernel on a remote machine (pure; unit tested). */

import { quotePath, shellQuote } from "./shellQuote";

export interface RemoteKernel {
  /** the unprivileged user the kernel runs as (the SSH user starts it with `sudo -u`; the kernel has no sudo itself) */
  user: string;
  /** that user's home: the kernel starts there (the SSH user's own home is closed to it) */
  home: string;
  /** Python with iara installed, on the machine */
  python: string;
  /** the kernel's working directory there (created if missing) */
  workspace: string;
  /** extra environment for the kernel (never credentials: the team bucket's keys stay with the machine's proxy) */
  env?: Record<string, string>;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const USER_NAME = /^[a-z_][a-z0-9_-]*$/;

export function remoteCommand(k: RemoteKernel): string {
  if (!USER_NAME.test(k.user)) throw new Error(`invalid user name: ${k.user}`);
  const env = { PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", ...k.env };
  const assignments = Object.entries(env).map(([name, value]) => {
    if (!ENV_NAME.test(name)) throw new Error(`invalid environment variable name: ${name}`);
    return `${name}=${shellQuote(value)}`;
  });
  return `exec sudo -n -u ${k.user} -H env -C ${quotePath(k.home)} ${assignments.join(" ")} ${quotePath(k.python)} -m iara.kernel --workspace ${quotePath(k.workspace)} --create`;
}
