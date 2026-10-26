/** A real-browser regression for label measurement and per-diagram SVG identities. */
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const root = join(import.meta.dir, "..");
const fixture = join(root, "apps/desktop/.run/diagram-check.tsx");
await mkdir(join(root, "apps/desktop/.run"), { recursive: true });
await Bun.write(fixture, `import {createRoot} from "react-dom/client";
import {StudyDiagram} from "../src/components/StudyDiagram";
const diagram="flowchart TD\\nA[Foundations] --> B[Application]\\nB --> C[Explain the reasoning]";
createRoot(document.getElementById("root")!).render(<><StudyDiagram diagram={diagram}/><StudyDiagram diagram={diagram}/></>);`);
const built = await Bun.build({ entrypoints: [fixture], target: "browser" });
assert(built.success, "Diagram fixture must compile");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
	return new URL(request.url).pathname === "/diagram.js"
		? new Response(built.outputs[0], { headers: { "Content-Type": "text/javascript" } })
		: new Response('<!doctype html><style>body{font:14px/1.45 system-ui;background:#10151d;color:#e6edf3}.study-diagram{width:220px;display:inline-block}</style><div id="root"></div><script type="module" src="/diagram.js"></script>', {headers:{"Content-Type":"text/html"}});
} });
const browser = await chromium.launch({ headless: true });
try {
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.goto(`http://127.0.0.1:${server.port}`);
	await page.locator(".study-diagram svg").nth(1).waitFor();
	const measurements = await page.locator(".pele-node[data-id]").evaluateAll(nodes => nodes.map(node => {
		const box = node.querySelector("rect")?.getBoundingClientRect();
		const label = node.querySelector("text")?.getBoundingClientRect();
		return { label: node.textContent, fits: Boolean(box && label && label.left >= box.left - 1 && label.right <= box.right + 1 && label.top >= box.top - 1 && label.bottom <= box.bottom + 1) };
	}));
	assert.equal(measurements.length, 6);
	assert(measurements.every(node => node.fits), JSON.stringify(measurements));
	const ids = await page.locator("svg [id]").evaluateAll(nodes => nodes.map(node => node.id));
	assert.equal(new Set(ids).size, ids.length, "Each diagram must use independent SVG ids");
	assert.deepEqual(errors, []);
	console.log("Diagram labels fit their nodes in a 220px rail; SVG ids are unique.");
} finally {
	await browser.close();
	server.stop(true);
	await rm(fixture, { force: true });
}
