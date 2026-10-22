import { describe, expect, it } from "vitest";

import { documentImportAssistRequestSchema } from "../src/contracts/document-import.zod.js";

describe("ADR-094 document import assist target", () => {
  it("accepts the legacy request without a target", () => {
    expect(
      documentImportAssistRequestSchema.parse({
        mode: "IN_PROJECT",
        text: "支付模块需求",
      }),
    ).toEqual({ mode: "IN_PROJECT", text: "支付模块需求" });
  });

  it("accepts project root, module and feature targets", () => {
    expect(
      documentImportAssistRequestSchema.parse({
        mode: "IN_PROJECT",
        text: "需求",
        target: { projectId: 2, moduleId: null, featureId: null },
      }).target,
    ).toEqual({ projectId: 2, moduleId: null, featureId: null });
    expect(
      documentImportAssistRequestSchema.parse({
        mode: "IN_PROJECT",
        text: "需求",
        target: { projectId: 2, moduleId: 7, featureId: null },
      }).target,
    ).toEqual({ projectId: 2, moduleId: 7, featureId: null });
    expect(
      documentImportAssistRequestSchema.parse({
        mode: "IN_PROJECT",
        text: "需求",
        target: { projectId: 2, moduleId: 7, featureId: 8 },
      }).target,
    ).toEqual({ projectId: 2, moduleId: 7, featureId: 8 });
  });

  it("rejects a target in whole-project mode", () => {
    expect(
      documentImportAssistRequestSchema.safeParse({
        mode: "WHOLE_PROJECT",
        text: "整项目需求",
        target: { projectId: 2, moduleId: null, featureId: null },
      }).success,
    ).toBe(false);
  });

  it("rejects a feature target without a module and unknown fields", () => {
    for (const target of [
      { projectId: 2, moduleId: null, featureId: 8 },
      { projectId: 2, moduleId: 7, featureId: 8, projectName: "伪造" },
    ]) {
      expect(
        documentImportAssistRequestSchema.safeParse({
          mode: "IN_PROJECT",
          text: "需求",
          target,
        }).success,
      ).toBe(false);
    }
  });
});
