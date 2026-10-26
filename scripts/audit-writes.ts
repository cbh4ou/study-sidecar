/** Test-only preload: reject filesystem mutations outside SIDECAR_HOME. */
import { mock } from "bun:test";
import * as fsModule from "node:fs";
import * as promisesModule from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
const fs = { ...fsModule };
const promises = { ...promisesModule };
const root = resolve(process.env.SIDECAR_HOME ?? "");
if (!process.env.SIDECAR_HOME)
	throw new Error("Write audit requires SIDECAR_HOME");
const records: Array<{ op: string; path: string }> = [];
function canonical(path: string): string {
	try {
		return fs.realpathSync(path);
	} catch {
		const parent = dirname(path);
		return parent === path
			? path
			: resolve(canonical(parent), path.slice(parent.length + 1));
	}
}
function guard(value: unknown, op: string): void {
	if (typeof value === "number") return;
	const path = canonical(
		resolve(value instanceof URL ? fileURLToPath(value) : String(value)),
	);
	records.push({ op, path });
	if (path !== root && !path.startsWith(`${root}${sep}`))
		throw new Error(`Write outside sidecar home: ${op} ${path}`);
}
const asyncWrites: Record<string, unknown> = { ...promises };
for (const name of [
	"writeFile",
	"appendFile",
	"mkdir",
	"chmod",
	"rm",
	"rmdir",
	"unlink",
	"truncate",
	"utimes",
] as const) {
	const original = promises[name] as (...args: any[]) => Promise<unknown>;
	asyncWrites[name] = (...args: any[]) => {
		guard(args[0], name);
		return original(...args);
	};
}
asyncWrites.rename = (from: any, to: any) => {
	guard(from, "rename from");
	guard(to, "rename to");
	return promises.rename(from, to);
};
asyncWrites.open = (path: any, flags: any, ...rest: any[]) => {
	if (
		typeof flags === "number"
			? (flags &
					(fs.constants.O_WRONLY |
						fs.constants.O_RDWR |
						fs.constants.O_CREAT |
						fs.constants.O_APPEND)) !==
				0
			: /[wa+]/.test(String(flags))
	)
		guard(path, "open");
	return (promises.open as any)(path, flags, ...rest);
};
mock.module("node:fs/promises", () => asyncWrites);
const syncWrites: Record<string, unknown> = { ...fs };
for (const name of [
	"writeFileSync",
	"appendFileSync",
	"mkdirSync",
	"chmodSync",
	"rmSync",
	"rmdirSync",
	"unlinkSync",
	"truncateSync",
	"utimesSync",
] as const) {
	const original = fs[name] as (...args: any[]) => unknown;
	syncWrites[name] = (...args: any[]) => {
		guard(args[0], name);
		return original(...args);
	};
}
syncWrites.renameSync = (from: any, to: any) => {
	guard(from, "rename from");
	guard(to, "rename to");
	return fs.renameSync(from, to);
};
syncWrites.openSync = (path: any, flags: any, ...rest: any[]) => {
	if (
		typeof flags === "number"
			? (flags &
					(fs.constants.O_WRONLY |
						fs.constants.O_RDWR |
						fs.constants.O_CREAT |
						fs.constants.O_APPEND)) !==
				0
			: /[wa+]/.test(String(flags))
	)
		guard(path, "openSync");
	return (fs.openSync as any)(path, flags, ...rest);
};
mock.module("node:fs", () => ({ ...syncWrites, default: syncWrites }));
const write = Bun.write.bind(Bun);
Bun.write = ((path: any, ...rest: any[]) => {
	guard(path, "Bun.write");
	return (write as any)(path, ...rest);
}) as typeof Bun.write;
process.on("exit", () => {
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		resolve(root, ".write-audit.json"),
		JSON.stringify(records),
		{ mode: 0o600 },
	);
});
