import { describe, expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { createGrokAcpExtension } from "./grok-acp-extension";

const ASK_METHODS = [
  "x.ai/ask_user_question",
  "_x.ai/ask_user_question",
] as const;
const PLAN_METHODS = ["x.ai/exit_plan_mode", "_x.ai/exit_plan_mode"] as const;
const ELICIT_METHODS = ["x.ai/mcp/elicit", "_x.ai/mcp/elicit"] as const;

function askParams() {
  return {
    sessionId: "grok-session-1",
    toolCallId: "tool-1",
    mode: "default",
    questions: [
      {
        id: "scope",
        question: "Which scope should Grok use?",
        options: [
          {
            label: "Workspace",
            description: "Use the current workspace",
          },
          { label: "Session" },
        ],
        multiSelect: null,
      },
    ],
  };
}

function planParams() {
  return {
    sessionId: "grok-session-1",
    toolCallId: "tool-plan-1",
    planContent: "# Plan\n\n1. Change the adapter.\n2. Run tests.",
  };
}

async function expectRequestError(
  operation: () => Promise<unknown>,
  code: number,
): Promise<RequestError> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(RequestError);
    if (!(error instanceof RequestError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error("Expected an ACP RequestError");
}

describe("Grok ACP extension", () => {
  for (const method of ASK_METHODS) {
    test(`handles ${method} and maps its questions`, async () => {
      let shownInput: Record<string, unknown> | undefined;
      const extension = createGrokAcpExtension({
        currentSessionId: () => "grok-session-1",
        unattended: false,
        onAskUser: async (input) => {
          shownInput = input;
          return {
            behavior: "allow",
            updatedInput: { answers: { scope: "Workspace" } },
          };
        },
      });

      const response = await extension.extMethod(method, askParams());

      expect(shownInput).toEqual({
        questions: [
          {
            id: "scope",
            question: "Which scope should Grok use?",
            header: "Question",
            options: [
              {
                label: "Workspace",
                description: "Use the current workspace",
              },
              { label: "Session", description: "Session" },
            ],
            multiSelect: false,
          },
        ],
      });
      expect(response).toEqual({
        outcome: "accepted",
        answers: { "Which scope should Grok use?": ["Workspace"] },
      });
    });
  }

  test("returns the exact cancelled response when the human denies a question", async () => {
    const extension = createGrokAcpExtension({
      currentSessionId: () => "grok-session-1",
      unattended: false,
      onAskUser: async () => ({
        behavior: "deny",
        message: "Question dismissed",
      }),
    });

    expect(
      await extension.extMethod("_x.ai/ask_user_question", askParams()),
    ).toEqual({ outcome: "cancelled" });
  });

  test("returns cancelled without fabricating an answer on unattended runs", async () => {
    let asked = false;
    const extension = createGrokAcpExtension({
      currentSessionId: () => "grok-session-1",
      unattended: true,
      onAskUser: async () => {
        asked = true;
        return {
          behavior: "allow",
          updatedInput: { answers: { scope: "Workspace" } },
        };
      },
    });

    expect(
      await extension.extMethod("x.ai/ask_user_question", askParams()),
    ).toEqual({ outcome: "cancelled" });
    expect(asked).toBe(false);
  });

  test("encodes custom answers as Other annotations", async () => {
    const extension = createGrokAcpExtension({
      currentSessionId: () => "grok-session-1",
      unattended: false,
      onAskUser: async () => ({
        behavior: "allow",
        updatedInput: { answers: { scope: "Repository only" } },
      }),
    });

    expect(
      await extension.extMethod("x.ai/ask_user_question", askParams()),
    ).toEqual({
      outcome: "accepted",
      answers: { "Which scope should Grok use?": ["Other"] },
      annotations: {
        "Which scope should Grok use?": { notes: "Repository only" },
      },
    });
  });

  test("preserves option previews for a single accepted choice", async () => {
    const extension = createGrokAcpExtension({
      currentSessionId: () => "grok-session-1",
      unattended: false,
      onAskUser: async () => ({
        behavior: "allow",
        updatedInput: { answers: { "Pick a patch?": "Focused" } },
      }),
    });

    const response = await extension.extMethod("x.ai/ask_user_question", {
      sessionId: "grok-session-1",
      toolCallId: "tool-preview",
      mode: "default",
      questions: [
        {
          question: "Pick a patch?",
          options: [
            { label: "Focused", preview: "Only the ACP adapter changes" },
          ],
        },
      ],
    });

    expect(response).toEqual({
      outcome: "accepted",
      answers: { "Pick a patch?": ["Focused"] },
      annotations: {
        "Pick a patch?": { preview: "Only the ACP adapter changes" },
      },
    });
  });

  test("rejects duplicate question text because xAI answers are keyed by text", async () => {
    const extension = createGrokAcpExtension({
      currentSessionId: () => "grok-session-1",
      unattended: false,
    });
    const params = askParams();
    params.questions.push({
      id: "scope-again",
      question: "Which scope should Grok use?",
      options: [{ label: "Everywhere" }],
      multiSelect: null,
    });

    const error = await expectRequestError(
      () => extension.extMethod("x.ai/ask_user_question", params),
      -32602,
    );
    expect(error.message).toContain("Invalid params");
  });

  for (const method of PLAN_METHODS) {
    test(`handles ${method} and includes the proposed plan in the approval ask`, async () => {
      let shownInput: Record<string, unknown> | undefined;
      const extension = createGrokAcpExtension({
        currentSessionId: () => "grok-session-1",
        unattended: false,
        onAskUser: async (input) => {
          shownInput = input;
          const questions = input.questions;
          if (!Array.isArray(questions)) {
            return { behavior: "deny", message: "Missing question" };
          }
          const question = questions[0];
          if (
            !question ||
            typeof question !== "object" ||
            !("question" in question) ||
            typeof question.question !== "string"
          ) {
            return { behavior: "deny", message: "Malformed question" };
          }
          return {
            behavior: "allow",
            updatedInput: {
              answers: { [question.question]: "Approve plan" },
            },
          };
        },
      });

      expect(await extension.extMethod(method, planParams())).toEqual({
        outcome: "approved",
      });
      expect(JSON.stringify(shownInput)).toContain("# Plan");
      expect(JSON.stringify(shownInput)).toContain("Request changes");
      expect(JSON.stringify(shownInput)).toContain("Abandon plan");
    });
  }

  test.each([
    {
      answer: "Approve plan",
      expected: { outcome: "approved" },
    },
    {
      answer: "Request changes",
      expected: {
        outcome: "cancelled",
        feedback: "Please revise the plan and request approval again.",
      },
    },
    {
      answer: "Abandon plan",
      expected: { outcome: "abandoned" },
    },
    {
      answer: "Use the existing parser instead",
      expected: {
        outcome: "cancelled",
        feedback: "Use the existing parser instead",
      },
    },
  ])("maps plan answer '$answer'", async ({ answer, expected }) => {
    const question =
      "Grok proposed this plan:\n\n# Plan\n\n1. Change the adapter.\n2. Run tests.\n\nWhat should happen next?";
    const extension = createGrokAcpExtension({
      currentSessionId: () => "grok-session-1",
      unattended: false,
      onAskUser: async () => ({
        behavior: "allow",
        updatedInput: { answers: { [question]: answer } },
      }),
    });

    expect(
      await extension.extMethod("_x.ai/exit_plan_mode", planParams()),
    ).toEqual(expected);
  });

  test("auto-approves plan exit explicitly for unattended runs", async () => {
    let asked = false;
    const extension = createGrokAcpExtension({
      currentSessionId: () => "grok-session-1",
      unattended: true,
      onAskUser: async () => {
        asked = true;
        return { behavior: "deny", message: "Should not be called" };
      },
    });

    expect(
      await extension.extMethod("x.ai/exit_plan_mode", planParams()),
    ).toEqual({ outcome: "approved" });
    expect(asked).toBe(false);
  });

  for (const method of ELICIT_METHODS) {
    test(`handles ${method} form input with typed content`, async () => {
      const extension = createGrokAcpExtension({
        currentSessionId: () => "grok-session-1",
        unattended: false,
        onAskUser: async () => ({
          behavior: "allow",
          updatedInput: {
            answers: {
              label: "Stable",
              retries: "3",
              notify: "Yes",
            },
          },
        }),
      });

      expect(
        await extension.extMethod(method, {
          sessionId: "grok-session-1",
          toolCallId: "mcp-tool-1",
          mode: "form",
          message: "Configure the release",
          requestedSchema: {
            type: "object",
            properties: {
              label: {
                type: "string",
                oneOf: [
                  { const: "stable", title: "Stable" },
                  { const: "preview", title: "Preview" },
                ],
              },
              retries: { type: "integer", title: "Retries" },
              notify: { type: "boolean", title: "Notify" },
            },
            required: ["label", "retries", "notify"],
          },
        }),
      ).toEqual({
        action: "accept",
        content: { label: "stable", retries: 3, notify: true },
      });
    });
  }

  test("handles standard ACP form elicitation", async () => {
    const extension = createGrokAcpExtension({
      currentSessionId: () => "grok-session-1",
      unattended: false,
      onAskUser: async () => ({
        behavior: "allow",
        updatedInput: { answers: { label: "Preview" } },
      }),
    });

    expect(
      await extension.createElicitation({
        sessionId: "grok-session-1",
        mode: "form",
        message: "Choose a release label",
        requestedSchema: {
          type: "object",
          properties: {
            label: {
              type: "string",
              oneOf: [
                { const: "stable", title: "Stable" },
                { const: "preview", title: "Preview" },
              ],
            },
          },
          required: ["label"],
        },
      }),
    ).toEqual({ action: "accept", content: { label: "preview" } });
  });

  test("cancels elicitation safely when no human is available", async () => {
    const extension = createGrokAcpExtension({
      currentSessionId: () => "grok-session-1",
      unattended: true,
    });

    expect(
      await extension.createElicitation({
        sessionId: "grok-session-1",
        mode: "form",
        message: "Enter a value",
        requestedSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      }),
    ).toEqual({ action: "cancel" });
  });

  test("accepts Grok's wrapped extension payload and plan field", async () => {
    const extension = createGrokAcpExtension({
      currentSessionId: () => "grok-session-1",
      unattended: true,
    });

    expect(
      await extension.extMethod("_x.ai/exit_plan_mode", {
        method: "x.ai/exit_plan_mode",
        params: {
          sessionId: "grok-session-1",
          plan: "# Wrapped plan",
        },
      }),
    ).toEqual({ outcome: "approved" });
  });

  test("pauses the activity watchdog while waiting for a human", async () => {
    const activity: string[] = [];
    const extension = createGrokAcpExtension({
      currentSessionId: () => "grok-session-1",
      unattended: false,
      onInteractionStart: () => activity.push("paused"),
      onInteractionEnd: () => activity.push("resumed"),
      onAskUser: async () => ({
        behavior: "allow",
        updatedInput: { answers: { scope: "Workspace" } },
      }),
    });

    await extension.extMethod("x.ai/ask_user_question", askParams());
    expect(activity).toEqual(["paused", "resumed"]);
  });

  test("resolves a hung standard prompt from xAI prompt_complete", async () => {
    const extension = createGrokAcpExtension({
      currentSessionId: () => "grok-session-1",
      unattended: false,
    });
    const pending = extension.beginPrompt("grok-session-1");

    await extension.extNotification("_x.ai/session/prompt_complete", {
      sessionId: "grok-session-1",
      promptId: pending.promptId,
      stopReason: "end_turn",
      agentResult: null,
    });

    expect(await pending.completion).toEqual({
      stopReason: "end_turn",
      _meta: {
        sessionId: "grok-session-1",
        promptId: pending.promptId,
        requestId: pending.promptId,
        agentResult: null,
      },
    });
  });

  test("ignores stale and foreign xAI prompt completions", async () => {
    const extension = createGrokAcpExtension({
      currentSessionId: () => "grok-session-1",
      unattended: false,
    });
    const pending = extension.beginPrompt("grok-session-1");
    let resolved = false;
    void pending.completion.then(() => {
      resolved = true;
    });

    await extension.extNotification("_x.ai/session/prompt_complete", {
      sessionId: "grok-session-2",
      promptId: pending.promptId,
      stopReason: "end_turn",
    });
    await extension.extNotification("_x.ai/session/prompt_complete", {
      sessionId: "grok-session-1",
      promptId: "stale-prompt",
      stopReason: "end_turn",
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    pending.finish();
  });

  test("rejects unknown extension requests with MethodNotFound", async () => {
    const extension = createGrokAcpExtension({
      currentSessionId: () => "grok-session-1",
      unattended: false,
    });

    const error = await expectRequestError(
      () => extension.extMethod("x.ai/not_a_real_method", {}),
      -32601,
    );
    expect(error.message).toContain("Method not found");
  });

  test("rejects malformed extension payloads with InvalidParams", async () => {
    const extension = createGrokAcpExtension({
      currentSessionId: () => "grok-session-1",
      unattended: false,
    });

    await expectRequestError(
      () =>
        extension.extMethod("x.ai/ask_user_question", {
          sessionId: "grok-session-1",
          toolCallId: "tool-1",
          questions: "not-an-array",
          mode: "default",
        }),
      -32602,
    );
  });

  test("rejects extension requests for another ACP session", async () => {
    const extension = createGrokAcpExtension({
      currentSessionId: () => "grok-session-current",
      unattended: false,
    });

    const error = await expectRequestError(
      () => extension.extMethod("x.ai/exit_plan_mode", planParams()),
      -32602,
    );
    expect(error.data).toEqual({
      method: "x.ai/exit_plan_mode",
      expectedSessionId: "grok-session-current",
      receivedSessionId: "grok-session-1",
    });
  });
});
