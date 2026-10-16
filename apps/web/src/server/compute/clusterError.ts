/** A cluster operation the user can fix (`type` names the cause). */
export class ClusterError extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = type;
  }
}
