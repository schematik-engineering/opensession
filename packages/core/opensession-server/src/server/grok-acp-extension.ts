import {
  RequestError,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type ElicitationPropertySchema,
} from "@agentclientprotocol/sdk";
import { z } from "zod";
import type { RunAgentOpts } from "./agent-runner";

const MAX_QUESTIONS = 20;
const MAX_OPTIONS = 50;
const MAX_QUESTION_CHARS = 16_000;
const MAX_PLAN_CHARS = 100_000;
const MAX_ELICITATION_FIELDS = 50;

const XAiOptionSchema = z.object({
  label: z.string().trim().min(1).max(1_000),
  description: z.string().trim().max(4_000).optional(),
  preview: z.string().trim().max(16_000).optional(),
  id: z.string().trim().min(1).max(1_000).optional(),
});

const XAiQuestionSchema = z
  .object({
    id: z.string().trim().min(1).max(1_000).optional(),
    question: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
    options: z.array(XAiOptionSchema).max(MAX_OPTIONS),
    multiSelect: z.boolean().nullable().optional(),
  })
  .superRefine((question, context) => {
    const labels = new Set<string>();
    for (const option of question.options) {
      if (labels.has(option.label)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate option label: ${option.label}`,
          path: ["options"],
        });
      }
      labels.add(option.label);
    }
  });

const XAiAskParamsSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    toolCallId: z.string().trim().min(1),
    questions: z.array(XAiQuestionSchema).min(1).max(MAX_QUESTIONS),
    mode: z.enum(["default", "plan"]),
  })
  .superRefine((params, context) => {
    const questionTexts = new Set<string>();
    for (const [index, question] of params.questions.entries()) {
      if (questionTexts.has(question.question)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate question text: ${question.question}`,
          path: ["questions", index, "question"],
        });
      }
      questionTexts.add(question.question);
    }
  });

const XAiPlanParamsSchema = z.object({
  sessionId: z.string().trim().min(1),
  toolCallId: z.string().trim().min(1).optional(),
  planContent: z.string().max(MAX_PLAN_CHARS).nullable().optional(),
  plan: z.string().max(MAX_PLAN_CHARS).nullable().optional(),
});

const XAiPromptCompleteSchema = z.object({
  sessionId: z.string().trim().min(1),
  promptId: z.string().trim().min(1).optional(),
  stopReason: z.string().trim().min(1).optional(),
  agentResult: z.unknown().optional(),
});

const XAiElicitationPropertySchema = z
  .object({
    type: z.string().trim().min(1).max(100),
    title: z.string().trim().max(1_000).nullable().optional(),
    description: z.string().trim().max(4_000).nullable().optional(),
    default: z.unknown().optional(),
    enum: z.array(z.string().max(4_000)).max(MAX_OPTIONS).optional(),
    oneOf: z
      .array(
        z.object({
          const: z.string().max(4_000),
          title: z.string().max(1_000),
          description: z.string().max(4_000).nullable().optional(),
        }),
      )
      .max(MAX_OPTIONS)
      .optional(),
    items: z.unknown().optional(),
  })
  .passthrough();

const XAiElicitationSchema = z
  .object({
    type: z.literal("object").optional(),
    title: z.string().max(1_000).nullable().optional(),
    description: z.string().max(4_000).nullable().optional(),
    properties: z.record(z.string().max(1_000), XAiElicitationPropertySchema),
    required: z
      .array(z.string().max(1_000))
      .max(MAX_ELICITATION_FIELDS)
      .optional(),
  })
  .superRefine((schema, context) => {
    if (Object.keys(schema.properties).length > MAX_ELICITATION_FIELDS) {
      context.addIssue({
        code: "custom",
        message: `At most ${MAX_ELICITATION_FIELDS} elicitation fields are supported`,
        path: ["properties"],
      });
    }
  });

const XAiElicitParamsSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    toolCallId: z.string().trim().min(1).nullable().optional(),
    mode: z.enum(["form", "url"]),
    message: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
    requestedSchema: XAiElicitationSchema.optional(),
    elicitationId: z.string().trim().min(1).max(1_000).optional(),
    url: z.string().url().max(16_000).optional(),
  })
  .passthrough();

const HumanAnswersSchema = z.record(
  z.string(),
  z.union([z.string(), z.array(z.string())]),
);

type XAiQuestion = z.infer<typeof XAiQuestionSchema>;
type XAiAskParams = z.infer<typeof XAiAskParamsSchema>;
type XAiPlanParams = z.infer<typeof XAiPlanParamsSchema>;
type AskUser = NonNullable<RunAgentOpts["onAskUser"]>;

export interface GrokAcpExtensionOptions {
  currentSessionId: () => string | undefined;
  unattended: boolean;
  onAskUser?: AskUser;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
  onActivity?: () => void;
}

export interface GrokPromptCompletion {
  stopReason:
    | "cancelled"
    | "end_turn"
    | "max_tokens"
    | "max_turn_requests"
    | "refusal";
  _meta: Record<string, unknown>;
}

export interface PendingGrokPrompt {
  promptId: string;
  completion: Promise<GrokPromptCompletion>;
  finish(response?: { _meta?: Record<string, unknown> | null }): void;
}

export interface GrokAcpExtension {
  extMethod(method: string, params: unknown): Promise<Record<string, unknown>>;
  extNotification(method: string, params: unknown): Promise<void>;
  createElicitation(
    params: CreateElicitationRequest,
  ): Promise<CreateElicitationResponse>;
  beginPrompt(sessionId: string): PendingGrokPrompt;
}

const METHOD_KIND = {
  "x.ai/ask_user_question": "ask_user_question",
  "_x.ai/ask_user_question": "ask_user_question",
  "x.ai/exit_plan_mode": "exit_plan_mode",
  "_x.ai/exit_plan_mode": "exit_plan_mode",
  "x.ai/mcp/elicit": "mcp_elicit",
  "_x.ai/mcp/elicit": "mcp_elicit",
} as const;
const GrokMethodSchema = z.enum([
  "x.ai/ask_user_question",
  "_x.ai/ask_user_question",
  "x.ai/exit_plan_mode",
  "_x.ai/exit_plan_mode",
  "x.ai/mcp/elicit",
  "_x.ai/mcp/elicit",
]);
const GrokNotificationSchema = z.enum([
  "x.ai/session/prompt_complete",
  "_x.ai/session/prompt_complete",
  "x.ai/mcp/elicit_complete",
  "_x.ai/mcp/elicit_complete",
]);

const COMPLETED_PROMPT_LIMIT = 128;

function unwrapParams(
  params: unknown,
  supportedMethods: readonly string[],
): unknown {
  const wrapper = z
    .object({ method: z.string(), params: z.unknown() })
    .safeParse(params);
  return wrapper.success && supportedMethods.includes(wrapper.data.method)
    ? wrapper.data.params
    : params;
}

function parseParams<T>(
  schema: z.ZodType<T>,
  params: unknown,
  method: string,
): T {
  const parsed = schema.safeParse(params);
  if (parsed.success) return parsed.data;
  throw RequestError.invalidParams(
    { method, issues: parsed.error.issues },
    `${method} payload is invalid`,
  );
}

function validateSession(
  receivedSessionId: string,
  currentSessionId: string | undefined,
  method: string,
): void {
  if (currentSessionId === receivedSessionId) return;
  throw RequestError.invalidParams(
    {
      method,
      expectedSessionId: currentSessionId ?? null,
      receivedSessionId,
    },
    currentSessionId
      ? "Extension request belongs to another ACP session"
      : "ACP session is not ready",
  );
}

function askQuestions(params: XAiAskParams): Record<string, unknown>[] {
  return params.questions.map((question) => ({
    id: question.id ?? question.question,
    question: question.question,
    header: "Question",
    options:
      question.options.length > 0
        ? question.options.map((option) => ({
            label: option.label,
            description: option.description || option.label,
          }))
        : [{ label: "OK", description: "Continue" }],
    multiSelect: question.multiSelect === true,
  }));
}

function answerValues(question: XAiQuestion, rawAnswer: unknown): string[] {
  const parsed = z
    .union([z.string(), z.array(z.string())])
    .safeParse(rawAnswer);
  if (!parsed.success) return [];
  const rawValues = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  return rawValues.flatMap((rawValue) => {
    const value = rawValue.trim();
    if (!value) return [];
    if (
      question.multiSelect !== true ||
      question.options.some((option) => option.label === value)
    ) {
      return [value];
    }
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  });
}

function normalizeAnswer(
  question: XAiQuestion,
  rawAnswer: unknown,
): {
  values: string[];
  annotation?: { preview?: string; notes?: string };
} | null {
  const values = answerValues(question, rawAnswer);
  if (values.length === 0) return null;
  const optionByLabel = new Map(
    question.options.map((option) => [option.label, option]),
  );
  const selected = values.flatMap((value) =>
    optionByLabel.has(value) ? [value] : [],
  );
  const notes = values.filter((value) => !optionByLabel.has(value));
  const preview =
    question.multiSelect === true
      ? undefined
      : values
          .map((value) => optionByLabel.get(value)?.preview?.trim())
          .find(Boolean);
  const annotation =
    preview || notes.length > 0
      ? {
          ...(preview ? { preview } : {}),
          ...(notes.length > 0 ? { notes: notes.join("\n") } : {}),
        }
      : undefined;
  return {
    values: selected.length > 0 ? selected : ["Other"],
    ...(annotation ? { annotation } : {}),
  };
}

function answerForQuestion(
  answers: z.infer<typeof HumanAnswersSchema>,
  question: XAiQuestion,
): unknown {
  return (
    (question.id ? answers[question.id] : undefined) ??
    answers[question.question]
  );
}

function acceptedAskResponse(
  params: XAiAskParams,
  answers: z.infer<typeof HumanAnswersSchema>,
): Record<string, unknown> | null {
  const normalized = params.questions.map((question) => ({
    question,
    answer: normalizeAnswer(question, answerForQuestion(answers, question)),
  }));
  if (normalized.some((entry) => entry.answer === null)) return null;
  const responseAnswers = Object.fromEntries(
    normalized.flatMap((entry) =>
      entry.answer ? [[entry.question.question, entry.answer.values]] : [],
    ),
  );
  const annotations = Object.fromEntries(
    normalized.flatMap((entry) =>
      entry.answer?.annotation
        ? [[entry.question.question, entry.answer.annotation]]
        : [],
    ),
  );
  return {
    outcome: "accepted",
    answers: responseAnswers,
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
}

async function handleAskUserQuestion(
  params: XAiAskParams,
  options: GrokAcpExtensionOptions,
): Promise<Record<string, unknown>> {
  if (options.unattended || !options.onAskUser) return { outcome: "cancelled" };
  options.onInteractionStart?.();
  let decision: Awaited<ReturnType<AskUser>>;
  try {
    decision = await options.onAskUser({ questions: askQuestions(params) });
  } finally {
    options.onInteractionEnd?.();
  }
  if (decision.behavior === "deny") return { outcome: "cancelled" };
  const parsedAnswers = HumanAnswersSchema.safeParse(
    decision.updatedInput.answers,
  );
  if (!parsedAnswers.success) return { outcome: "cancelled" };
  return (
    acceptedAskResponse(params, parsedAnswers.data) ?? {
      outcome: "cancelled",
    }
  );
}

function planQuestion(planContent: string | null | undefined): string {
  if (!planContent?.trim())
    return "Grok is ready to leave plan mode. What should happen next?";
  return `Grok proposed this plan:\n\n${planContent.trim()}\n\nWhat should happen next?`;
}

function planDecision(answer: string): Record<string, unknown> {
  const normalized = answer.trim();
  const choice = normalized.toLowerCase();
  if (choice.startsWith("approve")) return { outcome: "approved" };
  if (choice.startsWith("abandon")) return { outcome: "abandoned" };
  if (choice.startsWith("request changes")) {
    return {
      outcome: "cancelled",
      feedback: "Please revise the plan and request approval again.",
    };
  }
  return { outcome: "cancelled", feedback: normalized };
}

async function handleExitPlanMode(
  params: XAiPlanParams,
  options: GrokAcpExtensionOptions,
): Promise<Record<string, unknown>> {
  if (options.unattended) return { outcome: "approved" };
  if (!options.onAskUser) return { outcome: "abandoned" };
  const question = planQuestion(params.planContent ?? params.plan);
  options.onInteractionStart?.();
  let decision: Awaited<ReturnType<AskUser>>;
  try {
    decision = await options.onAskUser({
      questions: [
        {
          question,
          header: "Plan approval",
          options: [
            {
              label: "Approve plan",
              description: "Start implementing this plan",
            },
            {
              label: "Request changes",
              description: "Have Grok revise the plan and ask again",
            },
            {
              label: "Abandon plan",
              description: "Stop without implementing the plan",
            },
          ],
          multiSelect: false,
        },
      ],
    });
  } finally {
    options.onInteractionEnd?.();
  }
  if (decision.behavior === "deny") return { outcome: "abandoned" };
  const parsedAnswers = HumanAnswersSchema.safeParse(
    decision.updatedInput.answers,
  );
  if (!parsedAnswers.success) return { outcome: "abandoned" };
  const rawAnswer = parsedAnswers.data[question];
  const answer = Array.isArray(rawAnswer) ? rawAnswer[0] : rawAnswer;
  return typeof answer === "string" && answer.trim()
    ? planDecision(answer)
    : { outcome: "abandoned" };
}

type FormElicitationRequest = Extract<
  CreateElicitationRequest,
  { mode: "form" }
>;

type ElicitationField = {
  key: string;
  question: string;
  schema: ElicitationPropertySchema;
  required: boolean;
  choices: Array<{ label: string; value: string; description: string }>;
};

function schemaObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function enumChoices(
  schema: ElicitationPropertySchema,
): ElicitationField["choices"] {
  const raw = schemaObject(schema);
  if (Array.isArray(raw.oneOf)) {
    return raw.oneOf.flatMap((entry) => {
      const option = schemaObject(entry);
      if (typeof option.const !== "string") return [];
      const label =
        typeof option.title === "string" ? option.title : option.const;
      return [
        {
          label,
          value: option.const,
          description:
            typeof option.description === "string" ? option.description : label,
        },
      ];
    });
  }
  const enumValues = Array.isArray(raw.enum)
    ? raw.enum.filter((value): value is string => typeof value === "string")
    : [];
  if (enumValues.length > 0) {
    return enumValues.map((value) => ({
      label: value,
      value,
      description: value,
    }));
  }
  if (schema.type !== "array") return [];
  const items = schemaObject(raw.items);
  const itemValues = Array.isArray(items.enum)
    ? items.enum.filter((value): value is string => typeof value === "string")
    : [];
  return itemValues.map((value) => ({
    label: value,
    value,
    description: value,
  }));
}

function elicitationFields(params: FormElicitationRequest): ElicitationField[] {
  const required = new Set(params.requestedSchema.required ?? []);
  return Object.entries(params.requestedSchema.properties ?? {}).map(
    ([key, schema]) => {
      const raw = schemaObject(schema);
      const title =
        typeof raw.title === "string" && raw.title.trim() ? raw.title : key;
      const description =
        typeof raw.description === "string" && raw.description.trim()
          ? raw.description.trim()
          : undefined;
      let choices = enumChoices(schema);
      if (schema.type === "boolean") {
        choices = [
          { label: "Yes", value: "true", description: "Yes" },
          { label: "No", value: "false", description: "No" },
        ];
      } else if (choices.length === 0) {
        choices = [
          {
            label: "Enter value",
            value: "",
            description: "Type a custom value",
          },
        ];
      }
      if (!required.has(key)) {
        choices.push({
          label: "Skip",
          value: "__opensession_skip__",
          description: "Leave this optional field empty",
        });
      }
      return {
        key,
        question: description
          ? `${params.message}\n\n${title}: ${description}`
          : `${params.message}\n\n${title}`,
        schema,
        required: required.has(key),
        choices,
      };
    },
  );
}

function rawAnswerValues(rawAnswer: unknown): string[] {
  const parsed = z
    .union([z.string(), z.array(z.string())])
    .safeParse(rawAnswer);
  if (!parsed.success) return [];
  return (Array.isArray(parsed.data) ? parsed.data : [parsed.data])
    .map((value) => value.trim())
    .filter(Boolean);
}

function elicitationValue(
  field: ElicitationField,
  rawAnswer: unknown,
): { present: boolean; value?: string | number | boolean | string[] } {
  const answers = rawAnswerValues(rawAnswer);
  if (answers.includes("Skip")) return { present: false };
  const mapped = answers.map((answer) => {
    const choice = field.choices.find(
      (candidate) => candidate.label === answer,
    );
    return choice?.value || answer;
  });
  if (mapped.length === 0 || mapped.includes("Enter value"))
    return { present: false };
  switch (field.schema.type) {
    case "array":
      return { present: true, value: mapped };
    case "boolean": {
      const normalized = mapped[0]?.toLowerCase();
      if (normalized === "true" || normalized === "yes")
        return { present: true, value: true };
      if (normalized === "false" || normalized === "no")
        return { present: true, value: false };
      return { present: false };
    }
    case "number": {
      const value = Number(mapped[0]);
      return Number.isFinite(value)
        ? { present: true, value }
        : { present: false };
    }
    case "integer": {
      const value = Number(mapped[0]);
      return Number.isInteger(value)
        ? { present: true, value }
        : { present: false };
    }
    default:
      return { present: true, value: mapped[0] };
  }
}

async function handleElicitation(
  params: CreateElicitationRequest,
  options: GrokAcpExtensionOptions,
): Promise<CreateElicitationResponse> {
  const form = params as Partial<FormElicitationRequest>;
  if (
    params.mode !== "form" ||
    !form.requestedSchema ||
    options.unattended ||
    !options.onAskUser
  )
    return { action: "cancel" };
  if ("sessionId" in params && typeof params.sessionId === "string")
    validateSession(
      params.sessionId,
      options.currentSessionId(),
      "session/elicitation/create",
    );
  const fields = elicitationFields(params as FormElicitationRequest);
  if (fields.length === 0) return { action: "accept", content: {} };
  options.onInteractionStart?.();
  let decision: Awaited<ReturnType<AskUser>>;
  try {
    decision = await options.onAskUser({
      questions: fields.map((field) => ({
        id: field.key,
        question: field.question,
        header: "MCP input",
        options: field.choices.map(({ label, description }) => ({
          label,
          description,
        })),
        multiSelect: field.schema.type === "array",
      })),
    });
  } finally {
    options.onInteractionEnd?.();
  }
  if (decision.behavior === "deny") return { action: "decline" };
  const parsedAnswers = HumanAnswersSchema.safeParse(
    decision.updatedInput.answers,
  );
  if (!parsedAnswers.success) return { action: "cancel" };
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const field of fields) {
    const raw =
      parsedAnswers.data[field.key] ?? parsedAnswers.data[field.question];
    const converted = elicitationValue(field, raw);
    if (!converted.present) {
      if (field.required) return { action: "cancel" };
      continue;
    }
    content[field.key] = converted.value!;
  }
  return { action: "accept", content };
}

export function createGrokAcpExtension(
  options: GrokAcpExtensionOptions,
): GrokAcpExtension {
  const pending = new Map<
    string,
    {
      sessionId: string;
      resolve: (completion: GrokPromptCompletion) => void;
    }
  >();
  const completed: string[] = [];

  const rememberCompleted = (promptId: string): void => {
    if (completed.includes(promptId)) return;
    completed.push(promptId);
    if (completed.length > COMPLETED_PROMPT_LIMIT) completed.shift();
  };

  return {
    async extMethod(method, rawParams) {
      options.onActivity?.();
      const parsedMethod = GrokMethodSchema.safeParse(method);
      if (!parsedMethod.success) throw RequestError.methodNotFound(method);
      const kind = METHOD_KIND[parsedMethod.data];
      switch (kind) {
        case "ask_user_question": {
          const params = parseParams(
            XAiAskParamsSchema,
            unwrapParams(rawParams, [
              "x.ai/ask_user_question",
              "_x.ai/ask_user_question",
            ]),
            method,
          );
          validateSession(params.sessionId, options.currentSessionId(), method);
          return await handleAskUserQuestion(params, options);
        }
        case "exit_plan_mode": {
          const params = parseParams(
            XAiPlanParamsSchema,
            unwrapParams(rawParams, [
              "x.ai/exit_plan_mode",
              "_x.ai/exit_plan_mode",
            ]),
            method,
          );
          validateSession(params.sessionId, options.currentSessionId(), method);
          return await handleExitPlanMode(params, options);
        }
        case "mcp_elicit": {
          const params = parseParams(
            XAiElicitParamsSchema,
            unwrapParams(rawParams, ["x.ai/mcp/elicit", "_x.ai/mcp/elicit"]),
            method,
          );
          validateSession(params.sessionId, options.currentSessionId(), method);
          return await handleElicitation(
            params as CreateElicitationRequest,
            options,
          );
        }
        default: {
          const exhaustive: never = kind;
          return exhaustive;
        }
      }
    },
    async extNotification(method, rawParams) {
      options.onActivity?.();
      const parsedMethod = GrokNotificationSchema.safeParse(method);
      if (!parsedMethod.success) return;
      if (parsedMethod.data.includes("mcp/elicit_complete")) return;
      const notification = parseParams(
        XAiPromptCompleteSchema,
        rawParams,
        method,
      );
      const direct = notification.promptId
        ? pending.get(notification.promptId)
        : undefined;
      const entry =
        notification.promptId && direct
          ? ([notification.promptId, direct] as const)
          : notification.promptId
            ? undefined
            : [...pending.entries()].find(
                ([, candidate]) =>
                  candidate.sessionId === notification.sessionId,
              );
      if (!entry || completed.includes(entry[0])) return;
      const [promptId, candidate] = entry;
      if (candidate.sessionId !== notification.sessionId) return;
      pending.delete(promptId);
      rememberCompleted(promptId);
      candidate.resolve({
        stopReason: normalizeStopReason(notification.stopReason),
        _meta: {
          sessionId: notification.sessionId,
          promptId,
          requestId: promptId,
          ...(notification.stopReason ? {} : { xAiStopReasonMissing: true }),
          ...(notification.agentResult === undefined
            ? {}
            : { agentResult: notification.agentResult }),
        },
      });
    },
    beginPrompt(sessionId) {
      const promptId = `opensession-xai-${crypto.randomUUID()}`;
      let resolve!: (completion: GrokPromptCompletion) => void;
      const completion = new Promise<GrokPromptCompletion>((done) => {
        resolve = done;
      });
      pending.set(promptId, { sessionId, resolve });
      return {
        promptId,
        completion,
        finish(response) {
          pending.delete(promptId);
          const responseId = response?._meta?.promptId;
          rememberCompleted(
            typeof responseId === "string" && responseId
              ? responseId
              : promptId,
          );
        },
      };
    },
    async createElicitation(params) {
      options.onActivity?.();
      return await handleElicitation(params, options);
    },
  };
}

function normalizeStopReason(
  stopReason: string | undefined,
): GrokPromptCompletion["stopReason"] {
  switch (stopReason) {
    case "cancelled":
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
      return stopReason;
    default:
      return "end_turn";
  }
}
