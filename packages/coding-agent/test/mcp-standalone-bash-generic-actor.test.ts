import { describe, expect, test } from "bun:test";
import { resolveExecutionIdentity } from "../src/mcp/standalone-bash";

describe("standalone Bash generic durable actor attribution", () => {
	test("accepts non-KitDev durable KitControl actor identities", () => {
		for (const worker of ["KitGoalKeeper1", "KitArchitect2", "KitAuditor3", "KitOps4", "KitRelease5"]) {
			const identity = resolveExecutionIdentity({
				command: "true",
				worker,
				session_epoch: 1,
				execution_id: "generic-actor-test",
			});
			expect(identity).toEqual({ worker, sessionEpoch: 1, executionId: "generic-actor-test" });
		}
	});

	test("keeps rejecting malformed or non-KitControl actor names", () => {
		for (const worker of ["GoalKeeper1", "KitGoalKeeper", "KitGoalKeeper0", "KitGoalKeeper-1", "kitGoalKeeper1"]) {
			expect(() =>
				resolveExecutionIdentity({ command: "true", worker, session_epoch: 1, execution_id: "bad" }),
			).toThrow();
		}
	});
});
