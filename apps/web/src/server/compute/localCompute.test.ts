import { describe, expect, it } from "vitest";

import { localComputeEnabled } from "./localCompute";

describe("local compute", () => {
  it("is on in development and off in production", () => {
    expect(localComputeEnabled({})).toBe(true);
    expect(localComputeEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(localComputeEnabled({ NODE_ENV: "test" })).toBe(true);
    expect(localComputeEnabled({ NODE_ENV: "production" })).toBe(false);
  });

  it("is not enabled by RENDER or other hosting variables", () => {
    expect(localComputeEnabled({ NODE_ENV: "production", RENDER: "true" })).toBe(false);
  });

  it("follows IARA_LOCAL_COMPUTE when it is set", () => {
    for (const on of ["1", "true", "TRUE", "yes", " on "]) expect(localComputeEnabled({ NODE_ENV: "production", IARA_LOCAL_COMPUTE: on })).toBe(true);
    for (const off of ["0", "false", "no", "off", "anything"]) expect(localComputeEnabled({ NODE_ENV: "development", IARA_LOCAL_COMPUTE: off })).toBe(false);
  });

  it("treats an empty IARA_LOCAL_COMPUTE as unset", () => {
    expect(localComputeEnabled({ NODE_ENV: "production", IARA_LOCAL_COMPUTE: "" })).toBe(false);
    expect(localComputeEnabled({ NODE_ENV: "development", IARA_LOCAL_COMPUTE: "  " })).toBe(true);
  });
});
