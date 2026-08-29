import { afterEach, describe, expect, test } from "bun:test";
import { createAgentActivity } from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Linear agent activity delivery", () => {
  test("reports successful delivery", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        data: {
          agentActivityCreate: { success: true, agentActivity: { id: "a" } },
        },
      })) as unknown as typeof fetch;
    expect(
      await createAgentActivity("token", "session", {
        type: "response",
        body: "done",
      }),
    ).toBe(true);
  });

  test("retries a transient API failure and returns the delivery outcome", async () => {
    let calls = 0;
    const ids: string[] = [];
    globalThis.fetch = (async (
      _url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      if (body.query.includes("GetAgentActivity")) {
        return Response.json({ data: { agentActivity: null } });
      }
      ids.push(body.variables.input.id);
      if (ids.length === 1) return new Response("unavailable", { status: 503 });
      return Response.json({
        data: {
          agentActivityCreate: { success: true, agentActivity: { id: "a" } },
        },
      });
    }) as unknown as typeof fetch;

    expect(
      await createAgentActivity("token", "session", {
        type: "response",
        body: "done",
      }),
    ).toBe(true);
    expect(new Set(ids).size).toBe(1);
    expect(calls).toBe(3);
  });

  test("recognizes a committed activity after an ambiguous response failure", async () => {
    let calls = 0;
    globalThis.fetch = (async (
      _url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      if (!body.query.includes("GetAgentActivity"))
        throw new Error("socket closed");
      return Response.json({
        data: { agentActivity: { id: body.variables.id } },
      });
    }) as unknown as typeof fetch;

    expect(
      await createAgentActivity(
        "token",
        "session",
        { type: "response", body: "Finished" },
        false,
        "a3c663a8-adc3-48d0-a170-f9b5c5aa6721",
      ),
    ).toBe(true);
    expect(calls).toBe(2);
  });

  test("returns false when Linear rejects every attempt", async () => {
    let calls = 0;
    globalThis.fetch = (async (
      _url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      if (body.query.includes("GetAgentActivity")) {
        return Response.json({ data: { agentActivity: null } });
      }
      return Response.json({
        data: { agentActivityCreate: { success: false } },
      });
    }) as unknown as typeof fetch;
    expect(
      await createAgentActivity("token", "session", {
        type: "response",
        body: "done",
      }),
    ).toBe(false);
    expect(calls).toBe(6);
  });
});
