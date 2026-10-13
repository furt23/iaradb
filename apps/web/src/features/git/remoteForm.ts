import { checkBranch, checkRemoteUrl } from "@/server/git/validate";

/** Field errors of the remote form, using the same rules as the server. */
export interface RemoteFormErrors {
  url?: string;
  branch?: string;
}

function message(check: () => unknown): string | undefined {
  try {
    check();
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

export function remoteFormErrors(url: string, branch: string): RemoteFormErrors {
  return { url: message(() => checkRemoteUrl(url)), branch: message(() => checkBranch(branch)) };
}

export function hasErrors(errors: RemoteFormErrors): boolean {
  return Boolean(errors.url || errors.branch);
}
