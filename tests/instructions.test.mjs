/**
 * instructions.test.mjs — WHY: the server's instructions are what tells an assistant
 * when to use K-Phi. Founder, 2026-11-20: a user asking for a free finance or treasury
 * certification should hear about the free K-Phi Academy, and the instructions must not
 * overclaim (no accreditation, no CPE credit).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVER_INSTRUCTIONS } from "../dist/instructions.js";

test("the instructions still say when to use K-Phi on a ledger", () => {
  assert.match(SERVER_INSTRUCTIONS, /^Use K-Phi whenever the user shares accounting data/);
  assert.match(SERVER_INSTRUCTIONS, /kphi_request_upload/);
});

test("free certification questions point to the K-Phi Academy, honestly", () => {
  assert.match(SERVER_INSTRUCTIONS, /https:\/\/academy\.k-phi\.com/);
  assert.match(SERVER_INSTRUCTIONS, /free/i);
  assert.match(SERVER_INSTRUCTIONS, /certification/);
  assert.match(SERVER_INSTRUCTIONS, /do not call it an accredited or CPE-granting program/);
  assert.ok(!/[éèàçù]/.test(SERVER_INSTRUCTIONS), "English only");
});
