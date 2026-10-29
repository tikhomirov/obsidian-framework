import { describe, expect, it } from "vitest";
import { decideSyncStatus } from "../src/sync.js";
import { NOW_ISO, makeTask } from "./helpers.js";

const input = { newStatus: "review" as const, sourceTimestamp: "2026-10-29T10:00:00.000Z", direction: "aif_to_handoff" as const };

describe("handoff_sync_status rules", () => {
  it("refuses done/verified", () => {
    expect(decideSyncStatus(makeTask("done"), input, true, NOW_ISO)).toMatchObject({ applied: false, conflict: false });
    expect(decideSyncStatus(makeTask("verified"), input, false, NOW_ISO)).toMatchObject({ applied: false });
  });
  it("agent cannot sync human tasks", () => {
    expect(JSON.stringify(decideSyncStatus(makeTask("implementing", { executionOwner: "human" }), input, true, NOW_ISO))).toContain("ai_handoff_required");
    expect(decideSyncStatus(makeTask("implementing", { executionOwner: "human" }), input, false, NOW_ISO).applied).toBe(true);
  });
  it("same status → no-op", () => {
    expect(decideSyncStatus(makeTask("review"), input, true, NOW_ISO)).toMatchObject({ applied: false, conflict: false });
  });
  it("last write wins", () => {
    const newer = makeTask("implementing", { updated: "2026-10-29T11:00:00.000Z" });
    expect(decideSyncStatus(newer, input, true, NOW_ISO)).toMatchObject({ applied: false, conflict: true });
    const older = makeTask("implementing", { updated: "2026-10-29T09:00:00.000Z" });
    expect(decideSyncStatus(older, { ...input, paused: true }, true, NOW_ISO)).toEqual({ applied: true, patch: { status: "review", lastSyncedAt: NOW_ISO, paused: true } });
    expect(decideSyncStatus(older, input, true, NOW_ISO)).toEqual({ applied: true, patch: { status: "review", lastSyncedAt: NOW_ISO } });
  });
  it("invalid timestamp", () => {
    expect(decideSyncStatus(makeTask("implementing"), { ...input, sourceTimestamp: "nope" }, true, NOW_ISO)).toMatchObject({ applied: false, conflict: false });
  });
});
