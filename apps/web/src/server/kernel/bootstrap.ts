import "server-only";

import { PROTOCOL_VERSION, type KernelInfo } from "@iara/protocol";

import { kernelConfigFor } from "../workspace/sources";
import { KernelError, type KernelClient } from "./client";

/** A kernel speaking another protocol version cannot be used. */
export function checkProtocol(info: KernelInfo): void {
  if (info.protocol !== PROTOCOL_VERSION) {
    const where = info.host ? ` on ${info.host}` : "";
    throw new KernelError(
      "ProtocolMismatch",
      `the kernel${where} speaks protocol ${info.protocol}, the Studio ${PROTOCOL_VERSION}: install the same iara version there`,
    );
  }
}

/** Version check, then the catalog the Studio keeps (with the settings generated for its team bucket). */
export async function bootstrap(kernel: KernelClient, info: KernelInfo): Promise<KernelInfo> {
  checkProtocol(info);
  return kernel.call("workspace.configure", { toml: await kernelConfigFor(kernel) });
}
