import { type Mounted, mountAsync } from "pele/lazy";
import { type ReactElement, useEffect, useRef, useState } from "react";

const idPrefix = "mmd-";

/** Renders a Mermaid diagram after the browser has mounted the view. */
export function MermaidView({
	diagram,
	onNodeClick,
	className,
}: {
	diagram: string;
	onNodeClick?: (nodeId: string) => void;
	className?: string;
}): ReactElement {
	const container = useRef<HTMLDivElement>(null);
	const [failed, setFailed] = useState(false);
	const classes = ["mermaid-view", onNodeClick ? "clickable" : "", className]
		.filter(Boolean)
		.join(" ");

	useEffect(() => {
		if (typeof document === "undefined") return;
		const element = container.current;
		if (!element) return;

		let cancelled = false;
		let mounted: Mounted | undefined;
		let listener: ((event: MouseEvent) => void) | undefined;
		setFailed(false);

		mountAsync(element, diagram, {
			fontFamily: "inherit",
			idPrefix,
			links: false,
		})
			.then((instance) => {
				mounted = instance;
				if (cancelled) {
					instance.destroy();
					return;
				}
				if (instance.error) {
					setFailed(true);
					return;
				}
				if (!onNodeClick) return;

				for (const node of element.querySelectorAll(".pele-node[data-id]")) {
					node.setAttribute("title", "Open related diff");
				}

				listener = (event) => {
					const target = event.target as Element | null;
					const id = target
						?.closest(".pele-node[data-id]")
						?.getAttribute("data-id");
					if (id) onNodeClick(id);
				};
				element.addEventListener("click", listener);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});

		return () => {
			cancelled = true;
			if (listener) element.removeEventListener("click", listener);
			mounted?.destroy();
		};
	}, [diagram, onNodeClick]);

	if (failed) {
		return <pre className={`${classes} mermaid-fallback`}>{diagram}</pre>;
	}
	return <div className={classes} ref={container} />;
}
