import { describe, expect, it } from "vitest";

import { initials } from "./AccountMenu";

describe("initials", () => {
  it("takes the first letters of up to two words of a name or an email", () => {
    expect(initials("Ana Souza")).toBe("AS");
    expect(initials("ana.souza@x.com")).toBe("AS");
    expect(initials("ana@x.com")).toBe("A");
    expect(initials("Maria da Silva Costa")).toBe("MD");
  });
});
