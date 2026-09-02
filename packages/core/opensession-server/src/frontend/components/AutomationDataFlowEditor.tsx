import { useEffect, useState } from "react";
import {
  fetchDiscordAutomationChannels,
  type AutomationInput,
  type AutomationOutput,
  type DiscordAutomationChannel,
} from "../lib/api";
import {
  appendMessageOutput,
  appendReportOutput,
} from "../lib/automation-output-editor";
import { FIELD_LABEL, FORM_ROW } from "../lib/automation-form";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input, Select } from "../ui/input";
import { Tooltip } from "../ui/tooltip";
import { BrandMark } from "./BrandMark";
import { IconFileText2, IconTrash } from "./icons";

function uniqueFlowId(prefix: string, used: string[]): string {
  let candidate = prefix;
  let index = 2;
  while (used.includes(candidate)) candidate = `${prefix}-${index++}`;
  return candidate;
}

type DiscordChannelState =
  | { status: "loading" }
  | {
      status: "ready";
      channels: DiscordAutomationChannel[];
      defaultChannel?: string;
    }
  | { status: "error" };

export function AutomationDataFlowEditor({
  inputs,
  outputs,
  onInputsChange,
  onOutputsChange,
}: {
  inputs: AutomationInput[];
  outputs: AutomationOutput[];
  onInputsChange: (value: AutomationInput[]) => void;
  onOutputsChange: (value: AutomationOutput[]) => void;
}) {
  const updateInput = (index: number, value: AutomationInput) =>
    onInputsChange(inputs.map((input, at) => (at === index ? value : input)));
  const updateOutput = (index: number, value: AutomationOutput) =>
    onOutputsChange(
      outputs.map((output, at) => (at === index ? value : output)),
    );
  const [discordChannelState, setDiscordChannelState] =
    useState<DiscordChannelState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    fetchDiscordAutomationChannels()
      .then((result) => {
        if (active) setDiscordChannelState({ status: "ready", ...result });
      })
      .catch(() => {
        if (active) setDiscordChannelState({ status: "error" });
      });
    return () => {
      active = false;
    };
  }, []);

  const addMessageOutput = (type: "slack" | "discord") => {
    const channel =
      type === "discord" && discordChannelState.status === "ready"
        ? discordChannelState.defaultChannel
        : undefined;
    onOutputsChange(appendMessageOutput(outputs, type, channel));
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div>
        <span className="text-label font-medium text-fg">Data flow</span>
        <span className="ml-2 text-label text-dim">
          Gather and flatten inputs before each run, then publish the result
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex min-h-10 items-center gap-2">
          <span className="text-label font-medium text-dim">Inputs</span>
          <span className="text-supporting text-faint phone:hidden">
            Each source is bounded and treated as untrusted data
          </span>
          <div className="ml-auto flex gap-1.5">
            <Tooltip label="Add Slack input">
              <Button
                size="sm"
                variant="soft"
                icon={<BrandMark name="slack" size={16} />}
                aria-label="Add Slack input"
                className="phone:min-h-11 phone:w-11"
                onClick={() =>
                  onInputsChange([
                    ...inputs,
                    {
                      id: uniqueFlowId(
                        "slack",
                        inputs.map((input) => input.id),
                      ),
                      label: "Slack channel",
                      window: {
                        mode: "since_last_success",
                        minutes: 120,
                        overlapMinutes: 10,
                      },
                      reduce: {
                        model: "claude-haiku-4-5",
                        maxOutputChars: 8000,
                      },
                      source: {
                        type: "slack_channel",
                        channel: "",
                        includeThreads: true,
                        includeBots: false,
                        limit: 200,
                      },
                    },
                  ])
                }
              />
            </Tooltip>
            <Tooltip label="Add report input">
              <Button
                size="sm"
                variant="soft"
                icon={<IconFileText2 size={16} />}
                aria-label="Add report input"
                className="phone:min-h-11 phone:w-11"
                onClick={() =>
                  onInputsChange([
                    ...inputs,
                    {
                      id: uniqueFlowId(
                        "reports",
                        inputs.map((input) => input.id),
                      ),
                      label: "Previous reports",
                      source: {
                        type: "reports",
                        automationId: "self",
                        limit: 3,
                      },
                    },
                  ])
                }
              />
            </Tooltip>
          </div>
        </div>

        {inputs.length === 0 ? (
          <div className="rounded-panel border border-dashed border-line px-3 py-3 text-label text-faint">
            No collected inputs. The run receives only its instructions and
            trigger context.
          </div>
        ) : (
          inputs.map((input, index) => {
            const slack =
              input.source.type === "slack_channel" ? input.source : null;
            const reports =
              input.source.type === "reports" ? input.source : null;
            return (
              <div key={input.id} className="rounded-panel bg-surface p-3">
                <div className="mb-2 flex min-h-10 items-center gap-2 phone:flex-wrap">
                  <Select
                    className="max-w-[150px] phone:min-h-11 phone:max-w-none phone:flex-1"
                    value={input.source.type}
                    onChange={(e) => {
                      const source =
                        e.target.value === "slack_channel"
                          ? {
                              type: "slack_channel" as const,
                              channel: "",
                              includeThreads: true,
                              includeBots: false,
                              limit: 200,
                            }
                          : {
                              type: "reports" as const,
                              automationId: "self",
                              limit: 3,
                            };
                      updateInput(index, {
                        id: input.id,
                        label: input.label,
                        source,
                      });
                    }}
                  >
                    <option value="slack_channel">Slack channel</option>
                    <option value="reports">Report history</option>
                  </Select>
                  <Input
                    className="min-w-0 flex-1 phone:order-3 phone:min-h-11 phone:basis-full"
                    value={input.label || ""}
                    onChange={(e) =>
                      updateInput(index, { ...input, label: e.target.value })
                    }
                    placeholder="Label"
                  />
                  <Tooltip label="Remove input">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<IconTrash size={16} />}
                      aria-label="Remove input"
                      className="shrink-0 text-dim hover:text-red phone:min-h-11 phone:w-11"
                      onClick={() =>
                        onInputsChange(inputs.filter((_, at) => at !== index))
                      }
                    />
                  </Tooltip>
                </div>

                {slack && (
                  <>
                    <div className={FORM_ROW}>
                      <label className={FIELD_LABEL}>
                        Channel ID
                        <Input
                          className="mono-input"
                          value={slack.channel}
                          onChange={(e) =>
                            updateInput(index, {
                              ...input,
                              source: {
                                ...slack,
                                channel: e.target.value.toUpperCase(),
                              },
                            })
                          }
                          placeholder="C0123456789"
                        />
                      </label>
                      <label className={FIELD_LABEL}>
                        Initial lookback
                        <Input
                          type="number"
                          min={15}
                          max={10080}
                          value={input.window?.minutes ?? 120}
                          onChange={(e) =>
                            updateInput(index, {
                              ...input,
                              window: {
                                ...input.window,
                                minutes: Number(e.target.value),
                              },
                            })
                          }
                        />
                      </label>
                      <label className={FIELD_LABEL}>
                        Reducer model
                        <Input
                          value={input.reduce?.model || ""}
                          onChange={(e) =>
                            updateInput(index, {
                              ...input,
                              reduce: {
                                ...input.reduce,
                                model: e.target.value,
                              },
                            })
                          }
                          placeholder="Default Haiku"
                        />
                      </label>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-label text-dim">
                      <label className="flex min-h-10 items-center gap-2">
                        <Checkbox
                          checked={slack.includeThreads !== false}
                          onCheckedChange={(checked) =>
                            updateInput(index, {
                              ...input,
                              source: { ...slack, includeThreads: checked },
                            })
                          }
                        />
                        Include thread replies
                      </label>
                      <label className="flex min-h-10 items-center gap-2">
                        <Checkbox
                          checked={slack.includeBots === true}
                          onCheckedChange={(checked) =>
                            updateInput(index, {
                              ...input,
                              source: { ...slack, includeBots: checked },
                            })
                          }
                        />
                        Include bot messages
                      </label>
                    </div>
                  </>
                )}

                {reports && (
                  <div className={FORM_ROW}>
                    <label className={FIELD_LABEL}>
                      Automation ID
                      <Input
                        className="mono-input"
                        value={reports.automationId}
                        onChange={(e) =>
                          updateInput(index, {
                            ...input,
                            source: {
                              ...reports,
                              automationId: e.target.value,
                            },
                          })
                        }
                        placeholder="self"
                      />
                    </label>
                    <label className={FIELD_LABEL}>
                      Reports to include
                      <Input
                        type="number"
                        min={1}
                        max={10}
                        value={reports.limit ?? 3}
                        onChange={(e) =>
                          updateInput(index, {
                            ...input,
                            source: {
                              ...reports,
                              limit: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </label>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="mt-1 flex flex-col gap-2">
        <div className="flex min-h-10 items-center gap-2">
          <span className="text-label font-medium text-dim">Outputs</span>
          <span className="text-supporting text-faint phone:hidden">
            Reports are durable; message delivery is optional
          </span>
          <div className="ml-auto flex gap-1.5">
            {!outputs.some((output) => output.type === "report") && (
              <Tooltip label="Add report output">
                <Button
                  size="sm"
                  variant="soft"
                  icon={<IconFileText2 size={16} />}
                  aria-label="Add report output"
                  className="phone:min-h-11 phone:w-11"
                  onClick={() => onOutputsChange(appendReportOutput(outputs))}
                />
              </Tooltip>
            )}
            <Tooltip label="Send reports to Slack">
              <Button
                size="sm"
                variant="soft"
                icon={<BrandMark name="slack" size={16} />}
                aria-label="Add Slack output"
                className="phone:min-h-11 phone:w-11"
                onClick={() => addMessageOutput("slack")}
              />
            </Tooltip>
            <Tooltip label="Send reports to Discord">
              <Button
                size="sm"
                variant="soft"
                icon={<BrandMark name="discord" size={16} />}
                aria-label="Add Discord output"
                className="phone:min-h-11 phone:w-11"
                onClick={() => addMessageOutput("discord")}
              />
            </Tooltip>
          </div>
        </div>

        {outputs.length === 0 ? (
          <div className="rounded-panel border border-dashed border-line px-3 py-3 text-label text-faint">
            No required output. The run behaves like a normal automation
            session.
          </div>
        ) : (
          outputs.map((output, index) => {
            const name =
              output.type === "report"
                ? "Report"
                : output.type === "slack"
                  ? "Slack"
                  : "Discord";
            const discordChannels =
              discordChannelState.status === "ready"
                ? discordChannelState.channels
                : [];
            const selectedDiscordChannel =
              output.type === "discord" ? output.channel : "";
            const hasSelectedDiscordChannel = discordChannels.some(
              (channel) => channel.id === selectedDiscordChannel,
            );
            return (
              <div key={output.id} className="rounded-panel bg-surface p-3">
                <div className="flex min-h-10 items-center gap-2 phone:flex-wrap">
                  <span className="flex w-[110px] shrink-0 items-center gap-2 text-label font-medium text-fg phone:w-auto phone:flex-1">
                    {output.type === "report" ? (
                      <IconFileText2 size={18} className="text-dim" />
                    ) : (
                      <BrandMark name={output.type} size={18} />
                    )}
                    {name}
                  </span>
                  {output.type === "report" ? (
                    <Select
                      className="phone:order-3 phone:min-h-11 phone:basis-full"
                      value={output.publish || "always"}
                      onChange={(e) =>
                        updateOutput(index, {
                          ...output,
                          publish: e.target.value as "always" | "on_findings",
                        })
                      }
                    >
                      <option value="always">Publish every run</option>
                      <option value="on_findings">Only with findings</option>
                    </Select>
                  ) : (
                    <>
                      {output.type === "discord" &&
                      discordChannels.length > 0 ? (
                        <Select
                          className="min-w-0 flex-1 phone:order-3 phone:min-h-11 phone:basis-full"
                          aria-label="Discord channel"
                          value={output.channel}
                          onChange={(e) =>
                            updateOutput(index, {
                              ...output,
                              channel: e.target.value,
                            })
                          }
                        >
                          {!hasSelectedDiscordChannel && output.channel && (
                            <option value={output.channel}>
                              Channel {output.channel}
                            </option>
                          )}
                          {discordChannels.map((channel) => (
                            <option key={channel.id} value={channel.id}>
                              {channel.guildName} / #{channel.name}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <Input
                          className="mono-input min-w-0 flex-1 phone:order-3 phone:min-h-11 phone:basis-full"
                          aria-label={`${name} channel ID`}
                          value={output.channel}
                          onChange={(e) =>
                            updateOutput(index, {
                              ...output,
                              channel:
                                output.type === "slack"
                                  ? e.target.value.toUpperCase()
                                  : e.target.value,
                            })
                          }
                          placeholder={
                            output.type === "slack"
                              ? "C0123456789"
                              : "Discord channel ID"
                          }
                        />
                      )}
                      <label className="flex min-h-10 shrink-0 items-center gap-2 text-label text-dim phone:min-h-11">
                        <Checkbox
                          checked={output.enabled !== false}
                          onCheckedChange={(checked) =>
                            updateOutput(index, { ...output, enabled: checked })
                          }
                        />
                        Send
                      </label>
                    </>
                  )}
                  <Tooltip label={`Remove ${name.toLowerCase()} output`}>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<IconTrash size={16} />}
                      aria-label={`Remove ${name.toLowerCase()} output`}
                      className="shrink-0 text-dim hover:text-red phone:min-h-11 phone:w-11"
                      onClick={() =>
                        onOutputsChange(outputs.filter((_, at) => at !== index))
                      }
                    />
                  </Tooltip>
                </div>
                {output.type === "discord" &&
                  (discordChannelState.status !== "ready" ||
                    discordChannels.length === 0) && (
                    <p className="mt-1 text-supporting text-faint">
                      {discordChannelState.status === "loading"
                        ? "Loading connected Discord channels…"
                        : discordChannelState.status === "error"
                          ? "Enter a channel ID or check the Discord integration setup."
                          : "No allowed text channels were found. Enter a channel ID."}
                    </p>
                  )}
                {output.type !== "report" && (
                  <div className="mt-2 grid grid-cols-2 gap-3 phone:grid-cols-1">
                    <label className={FIELD_LABEL}>
                      Minimum urgency
                      <Select
                        value={output.minUrgency || "high"}
                        onChange={(e) =>
                          updateOutput(index, {
                            ...output,
                            minUrgency: e.target.value as
                              | "low"
                              | "medium"
                              | "high"
                              | "critical",
                          })
                        }
                      >
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                        <option value="critical">Critical</option>
                      </Select>
                    </label>
                    <label className={FIELD_LABEL}>
                      Minimum confidence
                      <Select
                        value={output.minConfidence || "high"}
                        onChange={(e) =>
                          updateOutput(index, {
                            ...output,
                            minConfidence: e.target.value as
                              | "low"
                              | "medium"
                              | "high",
                          })
                        }
                      >
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                      </Select>
                    </label>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
