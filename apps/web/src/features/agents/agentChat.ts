import type { IaraAdapter } from "@/features/iara/types";
import type { IaraFileContext } from "@/lib/iara/protocol";

/** The agent as its test chat reads it: the server reads the agent's files by its slug. */
export const agentContext = (slug: string): IaraFileContext => ({ surface: "agent", path: slug });

/** An agent answers questions and never changes files. */
export const NO_CHANGES: IaraAdapter = {
  async apply() {
    throw new Error("This agent only answers questions");
  },
};
