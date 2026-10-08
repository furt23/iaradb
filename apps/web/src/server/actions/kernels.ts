"use server";

import type { ResultPage, SortKey } from "@workhouse/protocol";

import { parseKernelKey } from "../kernel/keys";
import { kernels, type KernelStatus } from "../kernel/manager";
import { attempt, type ActionResult } from "../result";

/** Results live in the kernel that produced them, named by its key. */
export async function fetchResultPage(
  kernelKey: string,
  resultId: string,
  offset: number,
  limit: number,
  sort?: SortKey[],
): Promise<ActionResult<ResultPage>> {
  return attempt(() => kernels.get(parseKernelKey(kernelKey)).request("result.page", { result_id: resultId, offset, limit, sort }));
}

export async function exportResult(kernelKey: string, resultId: string, format: "csv" | "parquet", name?: string): Promise<ActionResult<{ path: string }>> {
  return attempt(() => kernels.get(parseKernelKey(kernelKey)).request("result.export", { result_id: resultId, format, name }));
}

export async function interruptKernel(kernelKey: string): Promise<ActionResult<{ interrupted: boolean }>> {
  return attempt(() => kernels.get(parseKernelKey(kernelKey)).request("interrupt", {}));
}

export async function restartKernel(kernelKey: string): Promise<ActionResult<null>> {
  return attempt(async () => {
    kernels.restart(parseKernelKey(kernelKey));
    return null;
  });
}

export async function kernelStatus(): Promise<ActionResult<KernelStatus[]>> {
  return attempt(async () => kernels.status());
}
