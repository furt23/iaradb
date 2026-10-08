/** The shell command that starts a kernel on a remote machine (pure; unit tested). */

import { quotePath, shellQuote } from "./shellQuote";

export interface RemoteKernel {
  /** Python with workhouse installed, on the machine */
  python: string;
  /** the kernel's working directory there (created if missing) */
  workspace: string;
  /** extra environment for the kernel (never credentials: the machine has its own role) */
  env?: Record<string, string>;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function remoteCommand(k: RemoteKernel): string {
  const env = { PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", ...k.env };
  const assignments = Object.entries(env).map(([name, value]) => {
    if (!ENV_NAME.test(name)) throw new Error(`invalid environment variable name: ${name}`);
    return `${name}=${shellQuote(value)}`;
  });
  return `exec env ${assignments.join(" ")} ${quotePath(k.python)} -m workhouse.kernel --workspace ${quotePath(k.workspace)} --create`;
}
