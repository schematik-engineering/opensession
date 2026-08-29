import { describe, expect, test } from "bun:test";
import { preferredNewSessionModel } from "./new-session-model";

const base = {
  models: [
    { id: "pi/anthropic/claude-fable-5" },
    { id: "pi/workspace-preset/ws-1/opus-fable" },
  ],
  default: "pi/anthropic/claude-fable-5",
  modelPref: "",
};

describe("preferredNewSessionModel", () => {
  test("leaves the choice to the server without a preference", () => {
    expect(preferredNewSessionModel(base)).toBe("");
  });
  test("preselects a valid personal model", () => {
    expect(
      preferredNewSessionModel({
        ...base,
        modelPref: "pi/anthropic/claude-fable-5",
      }),
    ).toBe("pi/anthropic/claude-fable-5");
  });
  test("migrates a retained Vercel preference onto the current catalog id", () => {
    expect(
      preferredNewSessionModel({
        ...base,
        models: [{ id: "pi/vercel-ai-gateway/zai/glm-5.3-flash" }],
        modelPref: "pi/vercel/zai/glm-5.3-flash",
      }),
    ).toBe("pi/vercel-ai-gateway/zai/glm-5.3-flash");
  });
  test("retains a workspace preset default", () => {
    expect(
      preferredNewSessionModel({
        ...base,
        default: "pi/workspace-preset/ws-1/opus-fable",
      }),
    ).toBe("pi/workspace-preset/ws-1/opus-fable");
  });
});
