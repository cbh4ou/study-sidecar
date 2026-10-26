import { useState } from "react";
import { useTelemetry } from "../lib/api";
import { useHudMessages } from "../lib/ws";
export function ActivityDock() {
	const [open, setOpen] = useState(false);
	const { state, send } = useHudMessages();
	const { data } = useTelemetry();
	const last = data?.turns.at(-1);
	return (
		<aside className="activity-dock">
			<button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
				Activity{" "}
				{state.jobs?.filter((j) => j.status === "running").length || ""}
			</button>
			{open && (
				<section className="activity-body">
					<h2>Background activity</h2>
					{state.jobs?.length ? (
						state.jobs.map((job) => (
							<div className="job-row" key={job.id}>
								<span>
									{job.label}
									<small>{job.status}</small>
								</span>
								{["running", "queued"].includes(job.status) && (
									<button
										type="button"
										onClick={() => send({ type: "abort_job", jobId: job.id })}
									>
										Abort
									</button>
								)}
							</div>
						))
					) : (
						<p>No background jobs.</p>
					)}
					<h3>Last turn</h3>
					<dl>
						{Object.entries(last ?? {})
							.filter(([key]) => !["turnId", "at"].includes(key))
							.map(([key, value]) => (
								<div key={key}>
									<dt>{key}</dt>
									<dd>{String(value)}</dd>
								</div>
							))}
					</dl>
				</section>
			)}
		</aside>
	);
}
