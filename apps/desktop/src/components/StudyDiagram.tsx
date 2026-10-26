import { type Mounted, mountAsync } from "pele/lazy";
import { useEffect, useId, useRef, useState } from "react";

/** Resolve the actual font before Pele measures labels, including narrow plan rails. */
export function StudyDiagram({ diagram }: { diagram: string }) {
	const container = useRef<HTMLDivElement>(null);
	const prefix = `study-${useId().replace(/[^a-z0-9]/gi, "")}-`;
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		const element = container.current;
		if (!element) return;
		let cancelled = false;
		let mounted: Mounted | undefined;
		setFailed(false);
		const style = getComputedStyle(element);
		void mountAsync(element, diagram, {
			fontFamily: style.fontFamily,
			fontSize: Number.parseFloat(style.fontSize) || 14,
			idPrefix: prefix,
			links: false,
			images: false,
		})
			.then((instance) => {
				if (cancelled) instance.destroy();
				else {
					mounted = instance;
					setFailed(Boolean(instance.error));
				}
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});
		return () => {
			cancelled = true;
			mounted?.destroy();
		};
	}, [diagram, prefix]);
	return (
		<div className="mermaid-view study-diagram">
			<div ref={container} hidden={failed} />
			{failed && <pre className="mermaid-fallback">{diagram}</pre>}
		</div>
	);
}
