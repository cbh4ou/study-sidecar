/** Secret redaction for model prompts, ported from sidecar_tutor/redact.py. */

const AUTHORIZATION_BEARER_RE =
	/\b(authorization)["']?\s*([=:])\s*["']?\s*bearer\s+\S+/gi;
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@?"'']+:[^\s/@]+@/gi;
const ASSIGNMENT_RE =
	/\b((?:[a-z0-9]+[_-])*?(?:api[_-]?key|token|secret|password|passwd|authorization|aws[_-]?secret[_-]?access[_-]?key|access[_-]?key|private[_-]?key|cookie|set[_-]?cookie))["']?\s*([=:])\s*["']?\s*(?:basic\s+|bearer\s+)?\S+/gi;
const BEARER_RE = /\b(bearer)\s+\S+/gi;
const SK_RE = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const GITHUB_RE =
	/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const JWT_RE =
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const PEM_RE = /-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;
const LONG_HEX_RE = /\b[0-9A-Fa-f]{32,}\b/g;

/** Replace common secret-bearing values with a stable placeholder. */
export function redact(text: string): string {
	return text
		.replace(AUTHORIZATION_BEARER_RE, "$1$2***")
		.replace(PEM_RE, "-----BEGIN $1-----***-----END $1-----")
		.replace(ASSIGNMENT_RE, "$1$2***")
		.replace(URL_USERINFO_RE, "$1***@")
		.replace(BEARER_RE, "$1 ***")
		.replace(GITHUB_RE, "gh*_***")
		.replace(JWT_RE, "***jwt***")
		.replace(SK_RE, "sk-***")
		.replace(LONG_HEX_RE, "***");
}
