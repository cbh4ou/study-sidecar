import { describe, expect, test } from "bun:test";
import { mapStatusToConnection } from "./connection";

describe("connection status mapping", () => {
	test("maps daemon auth rejections to unauthorized", () => {
		expect(mapStatusToConnection(401)).toBe("unauthorized");
		expect(mapStatusToConnection(403)).toBe("unauthorized");
	});

	test("leaves other statuses to normal handling", () => {
		expect(mapStatusToConnection(500)).toBeNull();
		expect(mapStatusToConnection(200)).toBeNull();
	});
});
