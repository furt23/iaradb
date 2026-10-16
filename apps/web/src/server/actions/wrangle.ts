"use server";

import type { WranglePreview, WrangleProfile, WrangleSource, WrangleStep } from "@iara/protocol";

import { requireUser } from "../auth/session";
import { parseKernelKey } from "../kernel/keys";
import { kernels } from "../kernel/manager";
import { attempt, type ActionResult } from "../result";

/** A Data Wrangler recipe, run in the kernel holding its source. */
export async function previewRecipe(kernelKey: string, source: WrangleSource, steps: WrangleStep[]): Promise<ActionResult<WranglePreview>> {
  return attempt(async () => {
    await requireUser();
    return kernels.get(parseKernelKey(kernelKey)).request("wrangle.preview", { source, steps });
  });
}

/** Statistics of one column of a recipe's result. */
export async function profileRecipeColumn(
  kernelKey: string,
  source: WrangleSource,
  steps: WrangleStep[],
  column: string,
): Promise<ActionResult<WrangleProfile>> {
  return attempt(async () => {
    await requireUser();
    return kernels.get(parseKernelKey(kernelKey)).request("wrangle.profile", { source, steps, column });
  });
}
