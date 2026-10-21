export type SessionEvent = {
	timestamp: string;
	event_type:
		| "user_task"
		| "agent_thought"
		| "agent_message"
		| "tool_call"
		| "tool_result";
	headline: string;
	details: string;
	id?: string;
	parent_id?: string;
	session_file?: string;
	diff?: string;
	bash_tail?: string;
	signals?: string[];
	dead_air?: boolean;
	tool_name?: string;
	file_path?: string;
	is_error?: boolean;
	metadata?: Record<string, unknown>;
};

export type SessionInfo = {
	id: string;
	project_name?: string;
	current_goal?: string;
	cwd?: string;
};

export type TailerCallbacks = {
	onEvent(event: SessionEvent): void;
	onSession?(session: SessionInfo): void;
	onError?(message: string): void;
};
