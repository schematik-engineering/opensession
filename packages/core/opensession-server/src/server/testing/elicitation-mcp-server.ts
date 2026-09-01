import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer(
  { name: "opensession-elicitation-probe", version: "1.0.0" },
  { capabilities: {} },
);

server.registerTool(
  "request_release_label",
  {
    description:
      "Request the release label from the user. Call this tool whenever the user asks for an elicitation compatibility probe.",
    inputSchema: {},
  },
  async () => {
    const result = await server.server.elicitInput({
      mode: "form",
      message: "Choose the release label for this compatibility probe.",
      requestedSchema: {
        type: "object",
        properties: {
          label: {
            type: "string",
            title: "Release label",
            oneOf: [
              { const: "stable", title: "Stable" },
              { const: "preview", title: "Preview" },
            ],
          },
        },
        required: ["label"],
      },
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result),
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
