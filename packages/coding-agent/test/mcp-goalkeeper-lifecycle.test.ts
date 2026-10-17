import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStandaloneTools, StandaloneHarness } from "../src/mcp/standalone-harness";

const tempDirs: string[] = [];
const savedEnv = { ...process.env };

const FORBIDDEN_AUTHORITY_FIELDS = [
	"generation",
	"session_epoch",
	"sessionEpoch",
	"task_run",
	"taskRun",
	"claim_hash",
	"claimHash",
	"lease_version",
	"leaseVersion",
	"execution_id",
	"executionId",
	"role",
	"command",
	"path",
];

afterEach(async () => {
	for (const key of Object.keys(process.env)) {
		if (!(key in savedEnv)) delete process.env[key];
	}
	for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
	await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function workspace(prefix = "omp-goalkeeper-lifecycle-"): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(path);
	return path;
}

async function executable(body: string): Promise<string> {
	const dir = await workspace();
	const path = join(dir, "tool");
	await writeFile(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`, "utf8");
	await chmod(path, 0o755);
	return path;
}

function lifecycleTool() {
	const harness = new StandaloneHarness("/tmp", createStandaloneTools());
	const tool = harness.getTool("goalkeeper_lifecycle");
	expect(tool).toBeDefined();
	return { harness, tool: tool! };
}

describe("GoalKeeper lifecycle model surface", () => {
	test("exposes semantic lifecycle fields only and no model authority credentials", () => {
		const { tool } = lifecycleTool();
		const parameters = tool.parameters as {
			properties?: Record<string, { enum?: string[] }>;
			required?: string[];
		};
		expect(parameters.required).toEqual(["action", "project"]);
		const properties = parameters.properties ?? {};
		for (const field of FORBIDDEN_AUTHORITY_FIELDS) expect(properties).not.toHaveProperty(field);
		expect(properties.action?.enum).toEqual([
			"supervisor_bootstrap",
			"onboard",
			"spawn",
			"bootstrap",
			"assess",
			"recover",
			"bind",
			"claim",
			"heartbeat",
			"block",
			"escalation_propose",
			"escalation_claim",
			"escalation_resolve",
			"close",
			"release",
			"park",
		]);
	});

	test("unknown authority arguments are rejected before bridge invocation", async () => {
		const root = await workspace();
		const marker = join(root, "bridge-called");
		process.env.OMP_KITCONTROL_GOALKEEPER_LIFECYCLE_BRIDGE = await executable(`touch ${JSON.stringify(marker)}`);
		process.env.OMP_KITCONTROL_GOALKEEPER_LIFECYCLE_PYTHON = "/bin/bash";
		const { harness } = lifecycleTool();
		const result = await harness.invokeTool({
			callId: "reject-authority",
			toolName: "goalkeeper_lifecycle",
			arguments: { action: "assess", project: "Demo", worker: "KitDev1", generation: 99 },
		});
		expect(result.isError).toBe(true);
		expect(await Bun.file(marker).exists()).toBe(false);
	});
});

describe("dedicated GoalKeeper lifecycle bridge", () => {
	test("invokes the dedicated bridge directly and never the general Bash execution bridge", async () => {
		const root = await workspace();
		const requestFile = join(root, "request.json");
		const bashMarker = join(root, "general-bash-called");
		const lifecycleBridge = await executable(`
			cat > ${JSON.stringify(requestFile)}
			printf '%s' '{"ok":true,"action":"block","project":"Demo","supervisor":{"worker":"KitGoalKeeper1","project":"Demo"},"worker":{"worker":"KitDev25","project":"Demo","lease_state":"CLAIMED","current_issue":"DEMO-001"},"state":"BLOCKED"}'
		`);
		process.env.OMP_KITCONTROL_GOALKEEPER_LIFECYCLE_BRIDGE = lifecycleBridge;
		process.env.OMP_KITCONTROL_GOALKEEPER_LIFECYCLE_PYTHON = "/bin/bash";
		process.env.OMP_KITCONTROL_EXEC_BRIDGE = await executable(`touch ${JSON.stringify(bashMarker)}`);
		const { harness } = lifecycleTool();
		const result = await harness.invokeTool({
			callId: "block",
			toolName: "goalkeeper_lifecycle",
			arguments: {
				action: "block",
				project: "Demo",
				worker: "KitDev25",
				blockers: ["OWNER_PRESERVED_LIFECYCLE_BLOCKED"],
				next: ["persist"],
				do_not: ["replace owner"],
			},
		});
		expect(result.isError).not.toBe(true);
		const request = JSON.parse(await readFile(requestFile, "utf8"));
		expect(request).toEqual({
			action: "block",
			project: "Demo",
			worker: "KitDev25",
			blockers: ["OWNER_PRESERVED_LIFECYCLE_BLOCKED"],
			next: ["persist"],
			do_not: ["replace owner"],
		});
		expect(await Bun.file(bashMarker).exists()).toBe(false);
		expect(result.content[0]).toMatchObject({ type: "text" });
	});

	test("fails closed when lifecycle bridge is missing", async () => {
		process.env.OMP_KITCONTROL_GOALKEEPER_LIFECYCLE_BRIDGE = "/definitely/missing/kit-goalkeeper-lifecycle";
		process.env.OMP_KITCONTROL_GOALKEEPER_LIFECYCLE_PYTHON = "/usr/bin/python3";
		const { harness } = lifecycleTool();
		const result = await harness.invokeTool({
			callId: "missing",
			toolName: "goalkeeper_lifecycle",
			arguments: { action: "supervisor_bootstrap", project: "Demo" },
		});
		expect(result.isError).toBe(true);
	});

	test("fails closed on non-zero or malformed bridge output", async () => {
		for (const bridge of [await executable("printf 'denied'; exit 42"), await executable("printf 'not-json'")]) {
			process.env.OMP_KITCONTROL_GOALKEEPER_LIFECYCLE_BRIDGE = bridge;
			process.env.OMP_KITCONTROL_GOALKEEPER_LIFECYCLE_PYTHON = "/bin/bash";
			const { harness } = lifecycleTool();
			const result = await harness.invokeTool({
				callId: "bad-bridge",
				toolName: "goalkeeper_lifecycle",
				arguments: { action: "supervisor_bootstrap", project: "Demo" },
			});
			expect(result.isError).toBe(true);
		}
	});
});
