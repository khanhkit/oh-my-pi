import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ExternalHarnessController } from "../src/harness/external-mode";
import { OhMyPiMcpServer } from "../src/mcp/server";
import { createStandaloneTools, StandaloneHarness } from "../src/mcp/standalone-harness";
import {
	createArchitectLifecycleTool,
	createGoalkeeperLifecycleTool,
	createUnifiedLifecycleTool,
	type TrustedLifecycleConfig,
} from "../src/mcp/standalone-kitcontrol-lifecycle";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function tempRoot(prefix = "omp-lifecycle-"): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(path);
	return path;
}

async function executable(path: string, body: string, mode = 0o755): Promise<string> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `#!/bin/sh\nset -eu\n${body}\n`, "utf8");
	await chmod(path, mode);
	return path;
}

async function trustedConfig(role: "KitGoalKeeper" | "KitArchitect" = "KitGoalKeeper") {
	const root = await tempRoot();
	const workspaceRoot = join(root, "workspace");
	const bridgeRoot = join(root, "machine", "bridge");
	const interpreterRoot = join(root, "machine", "python");
	await mkdir(workspaceRoot, { recursive: true });
	await mkdir(join(root, "authority"), { recursive: true });
	const requestFile = join(root, "request.json");
	const bridgeName = role === "KitGoalKeeper" ? "kit-goalkeeper-lifecycle" : "kit-architect-lifecycle";
	const bridgePath = await executable(
		join(bridgeRoot, "bin", bridgeName),
		`cat > ${JSON.stringify(requestFile)}\nprintf '%s' '{"ok":true,"action":"supervisor_bootstrap","project":"Demo"}'`,
	);
	const interpreterPath = await executable(join(interpreterRoot, "bin", "python"), 'exec /bin/sh "$@"');
	const config: TrustedLifecycleConfig = {
		role,
		project: "Demo",
		authorityRoot: join(root, "authority"),
		bridgePath,
		bridgeRoot,
		interpreterPath,
		interpreterRoot,
	};
	return { root, workspaceRoot, requestFile, config };
}

function schemaProperties(tool: ReturnType<typeof createGoalkeeperLifecycleTool>) {
	return (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
}

describe("machine-bound lifecycle model surface", () => {
	test("KitDev uses the same guarded action set as Architect and GoalKeeper", async () => {
		const { config } = await trustedConfig();
		const devConfig: TrustedLifecycleConfig = { ...config, role: "KitDev" };
		const tool = createUnifiedLifecycleTool(devConfig);
		const properties = schemaProperties(tool);
		const actions = (properties.action as { enum?: string[] }).enum ?? [];
		expect(actions).toContain("recover");
		expect(actions).toContain("claim");
		expect(actions).toContain("escalation_claim");
		expect(actions).toContain("escalation_resolve");
		expect(properties).not.toHaveProperty("caller_role");
		expect(properties).not.toHaveProperty("project");
		expect(properties).not.toHaveProperty("session_epoch");
		expect(tool.privileged).toBe(true);
		expect(createStandaloneTools().map(item => item.name)).not.toContain(tool.name);
	});


	test("GoalKeeper schema omits project/role/capability and Architect-only actions", async () => {
		const { config } = await trustedConfig();
		const tool = createGoalkeeperLifecycleTool(config);
		const properties = schemaProperties(tool);
		for (const field of [
			"project",
			"role",
			"capability",
			"architect_ref",
			"generation",
			"session_epoch",
			"task_run",
			"claim_hash",
			"lease_version",
			"execution_id",
			"command",
			"path",
		]) {
			expect(properties).not.toHaveProperty(field);
		}
		const actions = (properties.action as { enum?: string[] }).enum ?? [];
		expect(actions).toContain("escalation_propose");
		expect(actions).not.toContain("escalation_claim");
		expect(actions).not.toContain("escalation_resolve");
		expect(tool.write).toBe(true);
		expect(tool.execution).toBe(true);
		expect(tool.privileged).toBe(true);
	});

	test("Architect surface contains only machine-authorized escalation claim/resolve actions", async () => {
		const { config } = await trustedConfig("KitArchitect");
		const tool = createArchitectLifecycleTool(config);
		const properties = schemaProperties(tool as ReturnType<typeof createGoalkeeperLifecycleTool>);
		expect((properties.action as { enum?: string[] }).enum).toEqual(["escalation_claim", "escalation_resolve"]);
		expect(properties).not.toHaveProperty("project");
		expect(properties).not.toHaveProperty("architect_ref");
	});

	test("globally shared standalone tools do not contain privileged lifecycle", () => {
		expect(createStandaloneTools().map(tool => tool.name)).not.toContain("goalkeeper_lifecycle");
		expect(createStandaloneTools().map(tool => tool.name)).not.toContain("architect_lifecycle");
	});

	test("shared MCP entrypoints never register lifecycle tools", async () => {
		for (const file of ["run-server-standalone.ts", "run-server-http.ts", "run-server.ts"]) {
			const source = await readFile(new URL(`../src/mcp/${file}`, import.meta.url), "utf8");
			expect(source).not.toContain("createGoalkeeperLifecycleTool");
			expect(source).not.toContain("goalkeeper_lifecycle");
			expect(source).not.toContain("architect_lifecycle");
		}
	});

	test("production privileged entrypoint fixes executable trust roots under machine-only /run mount", async () => {
		const source = await readFile(new URL("../src/mcp/run-server-kitcontrol-lifecycle.ts", import.meta.url), "utf8");
		expect(source).toContain('const MACHINE_ROOT = "/run/kitcontrol-lifecycle"');
		expect(source).toContain("const INTERPRETER_ROOT = `${MACHINE_ROOT}/python-runtime`");
		expect(source).toContain("const INTERPRETER_PATH = `${INTERPRETER_ROOT}/bin/python3.13`");
		expect(source).not.toContain("const INTERPRETER_PATH = `${MACHINE_ROOT}/python3`");
		expect(source).not.toContain('"--bridge"');
		expect(source).not.toContain('"--interpreter"');
		expect(source).not.toContain('"--workspace-root"');
	});

	test("model cannot supply project/capability or invoke an action outside the machine role", async () => {
		const { workspaceRoot, requestFile, config } = await trustedConfig();
		const harness = new StandaloneHarness(workspaceRoot, [createGoalkeeperLifecycleTool(config)]);
		for (const arguments_ of [
			{ action: "supervisor_bootstrap", project: "Other" },
			{ action: "supervisor_bootstrap", capability: "forged" },
		]) {
			const result = await harness.invokeTool({
				callId: "forged",
				toolName: "goalkeeper_lifecycle",
				arguments: arguments_,
			});
			expect(result.isError).toBe(true);
		}
		const wrongAction = await harness.invokeTool({
			callId: "wrong-action",
			toolName: "goalkeeper_lifecycle",
			arguments: { action: "escalation_claim", id: "ESC-forged" },
		});
		expect(wrongAction.isError).toBe(true);
		expect(await Bun.file(requestFile).exists()).toBe(false);
		expect(() => createGoalkeeperLifecycleTool({ ...config, role: "KitArchitect" })).toThrow();
	});
});

describe("privileged permission metadata", () => {
	test("wildcard never authorizes privileged lifecycle, even with write/exec enabled", async () => {
		const { config } = await trustedConfig();
		const tool = createGoalkeeperLifecycleTool(config);
		const descriptor = new StandaloneHarness("/tmp", [tool]).getTool(tool.name)!;
		const controller = new ExternalHarnessController({
			enabled: true,
			allowedTools: ["*"],
			allowWrite: true,
			allowExecution: true,
			allowPrivileged: true,
		});
		expect(controller.authorizeInvocation(descriptor).allowed).toBe(false);
	});

	test("ordinary/shared MCP invocation is denied before privileged bridge execution", async () => {
		const { workspaceRoot, requestFile, config } = await trustedConfig();
		const tool = createGoalkeeperLifecycleTool(config);
		const harness = new StandaloneHarness(workspaceRoot, [tool]);
		const controller = new ExternalHarnessController({
			enabled: true,
			allowedTools: ["*"],
			allowWrite: true,
			allowExecution: true,
			allowPrivileged: true,
		});
		const server = new OhMyPiMcpServer(harness, { externalController: controller });
		const listed = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as any;
		expect(listed.result.tools).toHaveLength(0);
		const called = (await server.handleMessage({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: tool.name, arguments: { action: "supervisor_bootstrap" } },
		})) as any;
		expect(called.error?.code).toBe("PERMISSION_DENIED");
		expect(await Bun.file(requestFile).exists()).toBe(false);
	});

	test("explicit lifecycle permission still requires privileged, write, and execution gates", async () => {
		const { config } = await trustedConfig();
		const tool = createGoalkeeperLifecycleTool(config);
		const descriptor = new StandaloneHarness("/tmp", [tool]).getTool(tool.name)!;
		for (const disabled of ["privileged", "write", "execution"] as const) {
			const controller = new ExternalHarnessController({
				enabled: true,
				allowedTools: [tool.name],
				allowPrivileged: disabled !== "privileged",
				allowWrite: disabled !== "write",
				allowExecution: disabled !== "execution",
			});
			expect(controller.authorizeInvocation(descriptor).allowed).toBe(false);
		}
		const allowed = new ExternalHarnessController({
			enabled: true,
			allowedTools: [tool.name],
			allowPrivileged: true,
			allowWrite: true,
			allowExecution: true,
		});
		expect(allowed.authorizeInvocation(descriptor).allowed).toBe(true);
	});
});

describe("trusted lifecycle bridge", () => {
	test("injects machine-bound project outside model JSON", async () => {
		const { workspaceRoot, requestFile, config } = await trustedConfig();
		const harness = new StandaloneHarness(workspaceRoot, [createGoalkeeperLifecycleTool(config)]);
		const result = await harness.invokeTool({
			callId: "machine-project",
			toolName: "goalkeeper_lifecycle",
			arguments: { action: "supervisor_bootstrap" },
		});
		expect(result.isError).not.toBe(true);
		const request = JSON.parse(await readFile(requestFile, "utf8"));
		expect(request).toEqual({ action: "supervisor_bootstrap" });
	});

	test("rejects a symlink bridge before execution", async () => {
		const { root, workspaceRoot, config } = await trustedConfig();
		const link = join(root, "machine", "bridge", "bin", "bridge-link");
		await symlink(config.bridgePath, link);
		const harness = new StandaloneHarness(workspaceRoot, [
			createGoalkeeperLifecycleTool({ ...config, bridgePath: link }),
		]);
		const result = await harness.invokeTool({
			callId: "symlink-bridge",
			toolName: "goalkeeper_lifecycle",
			arguments: { action: "supervisor_bootstrap" },
		});
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text.toLowerCase()).toContain("symlink");
	});

	test("rejects mutable bridge and interpreter substitution", async () => {
		const { root, workspaceRoot, config } = await trustedConfig();
		await chmod(config.bridgePath, 0o777);
		let harness = new StandaloneHarness(workspaceRoot, [createGoalkeeperLifecycleTool(config)]);
		let result = await harness.invokeTool({
			callId: "mutable-bridge",
			toolName: "goalkeeper_lifecycle",
			arguments: { action: "supervisor_bootstrap" },
		});
		expect(result.isError).toBe(true);

		await chmod(config.bridgePath, 0o755);
		const substituted = await executable(join(root, "attacker", "python"), 'exec /bin/sh "$@"');
		harness = new StandaloneHarness(workspaceRoot, [
			createGoalkeeperLifecycleTool({ ...config, interpreterPath: substituted }),
		]);
		result = await harness.invokeTool({
			callId: "interpreter-substitution",
			toolName: "goalkeeper_lifecycle",
			arguments: { action: "supervisor_bootstrap" },
		});
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text.toLowerCase()).toContain("trusted");
	});

	test("rejects wrong bridge file type before execution", async () => {
		const { workspaceRoot, config } = await trustedConfig();
		await rm(config.bridgePath);
		await mkdir(config.bridgePath);
		const harness = new StandaloneHarness(workspaceRoot, [createGoalkeeperLifecycleTool(config)]);
		const result = await harness.invokeTool({
			callId: "bridge-directory",
			toolName: "goalkeeper_lifecycle",
			arguments: { action: "supervisor_bootstrap" },
		});
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text.toLowerCase()).toContain("regular file");
	});

	test("rejects mutable interpreter before execution", async () => {
		const { workspaceRoot, config } = await trustedConfig();
		await chmod(config.interpreterPath, 0o777);
		const harness = new StandaloneHarness(workspaceRoot, [createGoalkeeperLifecycleTool(config)]);
		const result = await harness.invokeTool({
			callId: "mutable-interpreter",
			toolName: "goalkeeper_lifecycle",
			arguments: { action: "supervisor_bootstrap" },
		});
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text.toLowerCase()).toContain("mutable");
	});

	test("rejects wrong interpreter file type before execution", async () => {
		const { workspaceRoot, config } = await trustedConfig();
		await rm(config.interpreterPath);
		await mkdir(config.interpreterPath);
		const harness = new StandaloneHarness(workspaceRoot, [createGoalkeeperLifecycleTool(config)]);
		const result = await harness.invokeTool({
			callId: "interpreter-directory",
			toolName: "goalkeeper_lifecycle",
			arguments: { action: "supervisor_bootstrap" },
		});
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text.toLowerCase()).toContain("regular file");
	});

	test("rejects symlink interpreter before execution", async () => {
		const { root, workspaceRoot, config } = await trustedConfig();
		const link = join(root, "machine", "python", "bin", "python-link");
		await symlink(config.interpreterPath, link);
		const harness = new StandaloneHarness(workspaceRoot, [
			createGoalkeeperLifecycleTool({ ...config, interpreterPath: link }),
		]);
		const result = await harness.invokeTool({
			callId: "symlink-interpreter",
			toolName: "goalkeeper_lifecycle",
			arguments: { action: "supervisor_bootstrap" },
		});
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text.toLowerCase()).toContain("symlink");
	});

	test("fails closed on non-zero and malformed bridge responses", async () => {
		for (const body of ["printf denied; exit 42", "printf not-json"]) {
			const { workspaceRoot, config } = await trustedConfig();
			await writeFile(config.bridgePath, `#!/bin/sh\nset -eu\n${body}\n`, "utf8");
			await chmod(config.bridgePath, 0o755);
			const harness = new StandaloneHarness(workspaceRoot, [createGoalkeeperLifecycleTool(config)]);
			const result = await harness.invokeTool({
				callId: "bad-bridge",
				toolName: "goalkeeper_lifecycle",
				arguments: { action: "supervisor_bootstrap" },
			});
			expect(result.isError).toBe(true);
		}
	});

	test("rejects machine bridge/interpreter paths inside model-writable workspace", async () => {
		const { workspaceRoot, config } = await trustedConfig();
		const badBridge = await executable(join(workspaceRoot, "bridge"), "exit 0");
		const harness = new StandaloneHarness(workspaceRoot, [
			createGoalkeeperLifecycleTool({ ...config, bridgePath: badBridge, bridgeRoot: workspaceRoot }),
		]);
		const result = await harness.invokeTool({
			callId: "workspace-bridge",
			toolName: "goalkeeper_lifecycle",
			arguments: { action: "supervisor_bootstrap" },
		});
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text.toLowerCase()).toContain("workspace");
	});
});
