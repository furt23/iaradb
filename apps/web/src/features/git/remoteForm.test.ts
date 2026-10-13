import { describe, expect, it } from "vitest";

import { hasErrors, remoteFormErrors } from "./remoteForm";

describe("remote form rules", () => {
  it("accepts a https url and a plain branch", () => {
    const errors = remoteFormErrors("https://github.com/team/analytics.git", "main");
    expect(errors).toEqual({ url: undefined, branch: undefined });
    expect(hasErrors(errors)).toBe(false);
  });

  it("explains a rejected url and branch", () => {
    const errors = remoteFormErrors("git@github.com:team/analytics.git", "../main");
    expect(errors.url).toMatch(/https:\/\//);
    expect(errors.branch).toMatch(/invalid branch/);
    expect(hasErrors(errors)).toBe(true);
  });

  it("flags urls that carry a token", () => {
    expect(remoteFormErrors("https://x-access-token:ghp_abc@github.com/a/b.git", "main").url).toMatch(/credentials/);
  });
});
