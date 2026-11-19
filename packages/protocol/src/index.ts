export * from "./assist";
export * from "./methods";
export * from "./notebook";
export * from "./query";
export * from "./results";
export * from "./stream";
export * from "./workspace";
export * from "./wrangle";

/**
 * Version of the kernel protocol these types describe. Version 2: the
 * Studio owns the workspace's files and sends them to kernels (which may run
 * on another machine).
 */
export const PROTOCOL_VERSION = 2;

/**
 * Version of the iara engine (Python package) this Studio runs on
 * clusters: they install the wheel published for it.
 */
export const ENGINE_VERSION = "0.2.0";
