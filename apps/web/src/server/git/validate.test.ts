import { describe, expect, it } from "vitest";

import { checkBranch, checkRemoteUrl, checkToken, displayUrl, redact } from "./validate";

describe("remote url", () => {
  it("accepts https urls", () => {
    expect(checkRemoteUrl(" https://github.com/team/analytics.git ")).toBe("https://github.com/team/analytics.git");
    expect(checkRemoteUrl("https://gitlab.example.com/group/sub/repo")).toBe("https://gitlab.example.com/group/sub/repo");
  });

  it("refuses other transports", () => {
    for (const url of ["http://github.com/a/b.git", "ssh://git@github.com/a/b.git", "git@github.com:a/b.git", "file:///tmp/repo", "/tmp/repo", "git://host/repo"]) {
      expect(() => checkRemoteUrl(url), url).toThrow();
    }
  });

  it("refuses credentials embedded in the url", () => {
    for (const url of ["https://user:pass@github.com/a/b.git", "https://x-access-token@github.com/a/b.git", "https://:@github.com/a/b.git", "https://user@github.com/a/b.git"]) {
      expect(() => checkRemoteUrl(url), url).toThrow(/credentials/);
    }
  });

  it("refuses empty urls, spaces and missing hosts", () => {
    expect(() => checkRemoteUrl("  ")).toThrow(/required/);
    expect(() => checkRemoteUrl("https://github.com/a b")).toThrow(/spaces/);
  });
});

describe("branch name", () => {
  it("accepts safe ref names", () => {
    for (const b of ["main", "release-2026.1", "team/feature_x", "v1.2"]) expect(checkBranch(b)).toBe(b);
  });

  it("refuses unsafe ref names", () => {
    for (const b of ["", "-main", "--upload-pack=x", "a..b", "a b", "a;rm", "a$b", "/main", "main/", "a//b", ".hidden", "a/.b", "x.lock", "a/b.lock", "x@{1}"]) {
      expect(() => checkBranch(b), b).toThrow();
    }
  });
});

describe("token", () => {
  it("accepts typical access tokens", () => {
    expect(checkToken("ghp_AbC123_def-456")).toBe("ghp_AbC123_def-456");
    expect(checkToken("glpat-xyz_123")).toBe("glpat-xyz_123");
  });

  it("refuses characters that would break the askpass helper", () => {
    for (const t of ["abc def", 'a"b', "a%PATH%b", "a\nb"]) expect(() => checkToken(t), t).toThrow();
  });
});

describe("redaction and display", () => {
  it("replaces every occurrence of a secret", () => {
    expect(redact("fatal: could not read token s3cr3t; retry s3cr3t", ["s3cr3t"])).toBe("fatal: could not read token ***; retry ***");
    expect(redact("nothing here", [undefined, ""])).toBe("nothing here");
  });

  it("shows the url without credentials", () => {
    expect(displayUrl("https://user:pass@github.com/a/b.git")).toBe("https://github.com/a/b.git");
    expect(displayUrl("https://github.com/a/b.git")).toBe("https://github.com/a/b.git");
  });
});
