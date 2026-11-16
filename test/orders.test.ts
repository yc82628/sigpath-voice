import { describe, expect, it } from "vitest";
import { normalizeOrderId } from "../src/tools/orders";

describe("normalizeOrderId", () => {
  it.each([
    ["SP-1042", "SP-1042"],
    ["sp1042", "SP-1042"],
    ["SP 1042", "SP-1042"],
    ["1042", "SP-1042"],
    ["S P one oh four two", "SP-1042"],
    ["s p one zero four two", "SP-1042"],
    ["es pee one oh four two", "SP-1042"],
    ["S.P. 1-0-4-2", "SP-1042"],
    ["SP one oh double four", "SP-1044"],
    ["SP one triple oh", "SP-1000"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeOrderId(input)).toBe(expected);
  });

  it.each([["SP-104"], ["SP-10422"], ["order please"], [""], ["XX-1042"]])("rejects %s", (input) => {
    expect(normalizeOrderId(input)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(normalizeOrderId(1042)).toBeNull();
    expect(normalizeOrderId(undefined)).toBeNull();
  });
});
