import type { IaraChange, IaraOutcome } from "@/lib/iara/protocol";

/** How the user answers the pending proposal from the file itself (the buttons over its diff). */
export interface IaraDecide {
  keep(run: boolean): void;
  undo(): void;
}

/** How the file under the panel (a notebook or the SQL editor) takes in a change Iara proposed and the user approved. */
export interface IaraAdapter {
  /** false while the file cannot run cells (its cluster is stopped): the cards offer only "keep" */
  canRun?: boolean;
  /**
   * Shows a proposed change in the file, as a diff the user can adjust, keep or
   * undo there; returns what takes it away. Shows nothing for a change with no
   * code, or whose edits no longer fit the file (the card says why).
   */
  preview?(change: IaraChange, decide: IaraDecide): () => void;
  /** Makes the change, with its code as the user adjusted it in the preview; with `run`, also runs it and waits for the result. A throw is reported to Iara as a change not applied. */
  apply(change: IaraChange, run: boolean): Promise<IaraOutcome>;
}
