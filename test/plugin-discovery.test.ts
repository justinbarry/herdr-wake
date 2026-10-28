import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAndLoadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { __closeExtensionParseCacheForTests } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { getAgentDir, getPluginsDir, removeSyncWithRetries, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

// Installs this checkout as a plugin in an isolated home and loads it through omp's own extension
// loader: it fails if the manifest entry is wrong or the module does not execute under the host.
describe("plugin package discovery", () => {
	let projectDir: TempDir;
	let tempHome = "";
	const originalAgentDir = getAgentDir();
	const xdgVars = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;
	const originalXdg = new Map<string, string | undefined>();

	beforeEach(() => {
		projectDir = TempDir.createSync("@herdr-wake-proj-");
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-wake-home-"));
		for (const key of xdgVars) {
			originalXdg.set(key, process.env[key]);
			delete process.env[key];
		}
		spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(path.join(tempHome, ".omp", "agent"));

		const pluginsDir = getPluginsDir();
		if (!pluginsDir.startsWith(tempHome + path.sep)) {
			throw new Error(`plugin isolation failed: ${pluginsDir}`);
		}

		const destDir = path.join(pluginsDir, "node_modules", "herdr-wake");
		fs.mkdirSync(path.dirname(destDir), { recursive: true });
		fs.symlinkSync(path.resolve(import.meta.dir, ".."), destDir, "dir");
		fs.writeFileSync(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({ name: "omp-plugins", private: true, dependencies: { "herdr-wake": "0.1.0" } }),
		);
	});

	afterEach(() => {
		projectDir.removeSync();
		spyOn(os, "homedir").mockRestore();
		for (const [key, value] of originalXdg) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		originalXdg.clear();
		setAgentDir(originalAgentDir);
		__closeExtensionParseCacheForTests();
		removeSyncWithRetries(tempHome);
	});

	it("discovers herdr-wake from its manifest and registers its flag and command", async () => {
		const result = await discoverAndLoadExtensions([], projectDir.path());
		expect(result.errors).toHaveLength(0);

		const extension = result.extensions.find(ext => ext.path.includes("herdr-wake"));
		expect(extension).toBeDefined();
		expect(extension?.flags.has("herdr-wake")).toBe(true);
		expect(extension?.commands.has("herdr")).toBe(true);
	});
});
