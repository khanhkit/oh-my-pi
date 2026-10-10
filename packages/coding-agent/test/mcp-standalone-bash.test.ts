import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resolveExecutionIdentity,
	runStandaloneBash,
} from "../src/mcp/standalone-bash";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "omp-standalone-bash-"));
	tempDirs.push(path);
	return path;
}

describe("standalone Bash attribution", () => {
	test("keeps command-only calls unattributed", () => {
		expect(resolveExecutionIdentity({ command: "printf ok" })).toBeUndefined();
	});

	test("requires worker and session_epoch together", () => {
		expect(() => resolveExecutionIdentity({ command: "true", worker: "KitDev19" })).toThrow();
		expect(() => resolveExecutionIdentity({ command: "true", session_epoch: 1 })).toThrow();
	});

	test("validates worker names and positive integer epochs", () => {
		expect(() => resolveExecutionIdentity({ command: "true", worker: "dev19", session_epoch: 1 })).toThrow();
		expect(() => resolveExecutionIdentity({ command: "true", worker: "KitDev19", session_epoch: 0 })).toThrow();
		expect(() => resolveExecutionIdentity({ command: "true", worker: "KitDev19", session_epoch: 1.5 })).toThrow();
	});

	test("generates an execution ID and preserves an explicit one", () => {
		const generated = resolveExecutionIdentity({ command: "true", worker: "KitDev19", session_epoch: 7 });
		expect(generated?.worker).toBe("KitDev19");
		expect(generated?.sessionEpoch).toBe(7);
		expect(generated?.executionId.length).toBeGreaterThan(0);

		const explicit = resolveExecutionIdentity({
			command: "true",
			worker: "KitDev19",
			session_epoch: 7,
			execution_id: "exec-123",
		});
		expect(explicit?.executionId).toBe("exec-123");
	});

	test("exports attribution only through the child environment", async () => {
		const cwd = await workspace();
		const command = "printf '%s|%s|%s' \"$KIT_WORKER\" \"$KIT_SESSION_EPOCH\" \"$KIT_EXECUTION_ID\"";
		const attributed = await runStandaloneBash(
			{ command, worker: "KitDev19", session_epoch: 9, execution_id: "exec-env" },
			{ cwd },
			{ rtkExecutable: "/definitely/missing/rtk" },
		);
		expect(attributed).toEqual({ text: "KitDev19|9|exec-env", isError: false });

		const unattributed = await runStandaloneBash(
			{ command },
			{ cwd },
			{ rtkExecutable: "/definitely/missing/rtk" },
		);
		expect(unattributed).toEqual({ text: "||", isError: false });
	});
});
