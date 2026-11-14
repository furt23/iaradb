import { describe, expect, it } from "vitest";

import { sourceOf } from "./lineageSource";

describe("sourceOf", () => {
  it("names a notebook by its path", () => {
    expect(sourceOf({ kernel: "notebook:etl/daily.ipynb", source: "etl/daily.ipynb" })).toEqual({
      kind: "notebook",
      id: "etl/daily.ipynb",
      label: "etl/daily.ipynb",
    });
  });

  it("names a job by the id in its source", () => {
    expect(sourceOf({ kernel: "job:run-9", source: "job j42" })).toEqual({ kind: "job", id: "j42", label: "j42" });
  });

  it("names a dashboard by its id and title, for editor and view runs", () => {
    expect(sourceOf({ kernel: "dashboard:a1b2c3d4", source: "dashboard Sales" })).toEqual({ kind: "dashboard", id: "a1b2c3d4", label: "Sales" });
    expect(sourceOf({ kernel: "dashboard:a1b2c3d4", source: "dashboard view Sales" })).toEqual({ kind: "dashboard", id: "a1b2c3d4", label: "Sales" });
  });

  it("names the chat agent Iara", () => {
    expect(sourceOf({ kernel: "assistant", source: "assistant" })).toEqual({ kind: "assistant", id: "assistant", label: "Iara" });
  });

  it("names the SQL editor by its source", () => {
    expect(sourceOf({ kernel: "workspace", source: "sql editor" })).toEqual({ kind: "sql", id: "sql editor", label: "sql editor" });
  });

  it("ignores the Studio's own reads", () => {
    expect(sourceOf({ kernel: "metadata", source: "catalog" })).toBeNull();
    expect(sourceOf({ kernel: "serving", source: "api" })).toBeNull();
  });

  it("keeps anything else as other", () => {
    expect(sourceOf({ kernel: "something", source: "analyze" })).toEqual({ kind: "other", id: "analyze", label: "analyze" });
  });
});
