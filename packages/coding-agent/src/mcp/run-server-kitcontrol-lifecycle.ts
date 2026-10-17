/** Dedicated machine-private KitControl lifecycle MCP entrypoint (stdio only). */
import { ExternalHarnessController } from "../harness/external-mode";
import { OhMyPiMcpServer } from "./server";
import { StandaloneHarness } from "./standalone-harness";
import {
	createArchitectLifecycleTool,
	createGoalkeeperLifecycleTool,
	type TrustedLifecycleConfig,
} from "./standalone-kitcontrol-lifecycle";

const MACHINE_ROOT = "/run/kitcontrol-lifecycle";
const BRIDGE_ROOT = `${MACHINE_ROOT}/KitControl`;
const INTERPRETER_ROOT = MACHINE_ROOT;
const INTERPRETER_PATH = `${MACHINE_ROOT}/python3`;

function machineArgs(argv: string[]): TrustedLifecycleConfig {
	const values = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
			throw new Error("invalid privileged lifecycle machine arguments");
		}
		if (values.has(flag)) throw new Error(`duplicate privileged lifecycle argument: ${flag}`);
		values.set(flag, value);
	}
	const required = ["--role", "--project", "--authority-root"];
	for (const flag of required)
		if (!values.has(flag)) throw new Error(`missing privileged lifecycle argument: ${flag}`);
	if (values.size !== required.length) throw new Error("unsupported privileged lifecycle machine argument");
	const role = values.get("--role");
	if (role !== "KitGoalKeeper" && role !== "KitArchitect")
		throw new Error("invalid privileged lifecycle machine role");
	return {
		role,
		project: values.get("--project")!,
		authorityRoot: values.get("--authority-root")!,
		bridgePath: `${BRIDGE_ROOT}/bin/${role === "KitGoalKeeper" ? "kit-goalkeeper-lifecycle" : "kit-architect-lifecycle"}`,
		bridgeRoot: BRIDGE_ROOT,
		interpreterPath: INTERPRETER_PATH,
		interpreterRoot: INTERPRETER_ROOT,
	};
}

const config = machineArgs(process.argv.slice(2));
const workspaceRoot = process.cwd();
const tool =
	config.role === "KitGoalKeeper" ? createGoalkeeperLifecycleTool(config) : createArchitectLifecycleTool(config);
const harness = new StandaloneHarness(workspaceRoot, [tool]);
const externalController = new ExternalHarnessController({
	enabled: true,
	allowedTools: [tool.name],
	allowWrite: true,
	allowExecution: true,
	allowPrivileged: true,
	workspaceRoot,
});
const server = new OhMyPiMcpServer(harness, {
	serverInfo: { name: "OhMyPi KitControl Lifecycle", version: "1.0.0" },
	externalController,
});
server.startStdioServer();

export { externalController, harness, server };
