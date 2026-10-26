import type { WebPage, WebResult, WebSearchPort } from "../ports/web.ts";

export const FAKE_WEB_RESULTS: WebResult[] = [
	{
		title: "Consumer Acknowledgements and Publisher Confirms",
		url: "https://www.rabbitmq.com/docs/confirms",
		snippet:
			"Delivery acknowledgements tell the broker a message was processed. Unacked messages are redelivered when the channel closes.",
	},
	{
		title: "Delivery acknowledgement timeout",
		url: "https://www.rabbitmq.com/docs/consumers#acknowledgement-timeout",
		snippet:
			"If a consumer does not ack a delivery within the timeout (30 minutes by default) the channel is closed with PRECONDITION_FAILED.",
	},
	{
		title: "Python Pika: basic_ack and prefetch",
		url: "https://pika.readthedocs.io/en/stable/modules/channel.html",
		snippet:
			"basic_qos sets the prefetch count; basic_ack acknowledges one or more messages by delivery tag.",
	},
];

export const FAKE_PAGE_TEXT = `Consumer Acknowledgements
When a broker delivers a message to a consumer it waits for an acknowledgement before it forgets the message.
A consumer that crashes or times out before acking causes the message to be requeued and delivered again.
Use manual acks for work that must not be lost, and keep the prefetch count small so slow consumers do not hoard messages.`;

/** Canned web results for fake mode; never touches the network. */
export class FakeWeb implements WebSearchPort {
	readonly configured = true;
	readonly queries: string[] = [];

	async search(
		query: string,
		opts: { limit?: number } = {},
	): Promise<WebResult[]> {
		this.queries.push(query);
		return FAKE_WEB_RESULTS.slice(0, opts.limit ?? FAKE_WEB_RESULTS.length);
	}

	async fetch(url: string, opts: { maxChars?: number } = {}): Promise<WebPage> {
		const known = FAKE_WEB_RESULTS.find((result) => result.url === url);
		return {
			url,
			title: known?.title ?? "Consumer Acknowledgements",
			text: FAKE_PAGE_TEXT.slice(0, opts.maxChars ?? 20_000),
		};
	}
}
