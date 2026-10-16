import type { TFunction } from "i18next";

import { pipSpecError } from "@/lib/pipSpec";

/** Why `spec` is not a valid pip requirement, translated; null when it is valid or empty. */
export function pipSpecMessage(spec: string, t: TFunction): string | null {
  const error = spec.trim() ? pipSpecError(spec.trim()) : null;
  if (!error) return null;
  const version = /^bad version "(.*)"$/.exec(error);
  if (version) return t('bad version "{{version}}"', { version: version[1] });
  const length = /^longer than (\d+) characters$/.exec(error);
  if (length) return t("longer than {{n}} characters", { n: length[1] });
  return t(error);
}
