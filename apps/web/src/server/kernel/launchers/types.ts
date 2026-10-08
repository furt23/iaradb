import type { Transport } from "../transport";

/**
 * Where kernels run: locally, or on a compute target reached over SSH.
 * The Studio owns the workspace's files either way (protocol 2).
 */
export interface Launcher {
  /** "local" or the compute target's name */
  readonly name: string;
  /**
   * The kernel's workspace directory when it is on this machine (files the
   * kernel writes, such as exports, can be read directly); null when remote.
   */
  readonly localRoot: string | null;
  /** start a kernel process */
  start(label: string): Transport;
}
