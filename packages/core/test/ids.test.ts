import { describe, expect, it } from "vitest";
import { branchNameFor, formatTaskId, formatTaskRef, isProjectId, isTaskId, nextTaskNumber, parseTaskRef, taskNumber } from "../src/ids.js";

describe("ids", () => {
  it("formats and parses", () => {
    expect(formatTaskId(12)).toBe("TASK-012");
    expect(formatTaskId(1234)).toBe("TASK-1234");
    expect(() => formatTaskId(0)).toThrow(RangeError);
    expect(isTaskId("TASK-012")).toBe(true);
    expect(isTaskId("TASK-12")).toBe(false);
    expect(taskNumber("TASK-012")).toBe(12);
    expect(() => taskNumber("x")).toThrow(RangeError);
    expect(isProjectId("of")).toBe(true);
    expect(isProjectId("Bad Id")).toBe(false);
  });
  it("parses refs", () => {
    expect(parseTaskRef("of/TASK-012")).toEqual({ project: "of", id: "TASK-012" });
    expect(parseTaskRef("of:TASK-012")).toEqual({ project: "of", id: "TASK-012" });
    expect(parseTaskRef("TASK-012", "of")).toEqual({ project: "of", id: "TASK-012" });
    expect(parseTaskRef("TASK-012")).toBeNull();
    expect(parseTaskRef("Bad/TASK-012")).toBeNull();
    expect(parseTaskRef("garbage", "of")).toBeNull();
    expect(formatTaskRef({ project: "of", id: "TASK-001" })).toBe("of/TASK-001");
  });
  it("next number never reuses ids", () => {
    expect(nextTaskNumber(1, [])).toBe(1);
    expect(nextTaskNumber(5, ["TASK-002"])).toBe(5);
    expect(nextTaskNumber(3, ["TASK-009", "junk"])).toBe(10);
    expect(nextTaskNumber(0, [])).toBe(1);
  });
  it("branch names", () => {
    expect(branchNameFor({ project: "of", id: "TASK-012" }, "Fix Login Page!")).toBe("of/task-012-fix-login-page");
    expect(branchNameFor({ project: "of", id: "TASK-012" }, "Починить вход")).toBe("of/task-012");
  });
});
