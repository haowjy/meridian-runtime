/**
 * Tests the reasoning level rule.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - a tie between two listed levels goes to the higher one
 */
import { describe, expect, it } from "vitest";
import { resolveReasoning } from "./resolve-call.js";

const LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

describe("resolveReasoning", () => {
  it.each([
    ["absent is the default", undefined, ["low", "high"], "default"],
    ["a listed level is used as asked", "xhigh", ["low", "xhigh"], { effort: "xhigh" }],
    [
      "a listed level off the ladder is used as asked",
      "turbo",
      ["low", "turbo"],
      { effort: "turbo" },
    ],
    ["the nearest listed level", "medium", ["low", "max"], { effort: "low" }],
    ["a tie goes to the higher level", "medium", ["low", "high"], { effort: "high" }],
    ["none is used when listed", "none", ["none", "low"], { effort: "none" }],
    [
      "none of a model that can't switch off is its lowest level",
      "none",
      ["low", "high"],
      { effort: "low" },
    ],
    ["a request never moves onto none", "minimal", ["none", "high"], { effort: "high" }],
    ["a model listing nothing on the ladder is the default", "high", ["turbo"], "default"],
    [
      "a request neither listed nor on the ladder is the default",
      "turbo",
      ["low", "high"],
      "default",
    ],
  ])("%s", (_name, requested, efforts, expected) => {
    expect(resolveReasoning(requested, { efforts }, LEVELS)).toEqual(expected);
  });
});
