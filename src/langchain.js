import { PromptTemplate } from "@langchain/core/prompts";

const promptTemplate = "{text}";
const template = PromptTemplate.fromTemplate(promptTemplate);

const parseJsonOrNull = (value) => {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const toToolHints = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const toString = (value) => (typeof value === "string" ? value : String(value ?? ""));

let cachedMcpRuntime = null;
let cachedMcpUrl = "";

const normalizeToolResult = (value) => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const extractMcpCalls = (parsedInput) => {
  if (!parsedInput || typeof parsedInput !== "object") return [];
  const rawCalls = Array.isArray(parsedInput.mcp_calls) ? parsedInput.mcp_calls : [];
  return rawCalls
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const toolName = toString(item.tool || item.name).trim();
      if (!toolName) return null;
      const args = item.args && typeof item.args === "object" ? item.args : {};
      return { toolName, args };
    })
    .filter(Boolean);
};

const getMcpRuntime = async (mcpServerUrl) => {
  const normalizedUrl = toString(mcpServerUrl).trim();
  if (!normalizedUrl) return null;

  if (cachedMcpRuntime && cachedMcpUrl === normalizedUrl) {
    return cachedMcpRuntime;
  }

  try {
    const { MultiServerMCPClient } = await import("@langchain/mcp-adapters");
    const client = new MultiServerMCPClient({
      zodiac: {
        transport: "http",
        url: normalizedUrl
      }
    });
    const tools = await client.getTools();
    const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
    cachedMcpRuntime = { client, tools, toolMap };
    cachedMcpUrl = normalizedUrl;
    return cachedMcpRuntime;
  } catch (error) {
    return {
      loadError: `Unable to initialize LangChain MCP tools: ${toString(error?.message || error)}`,
      tools: [],
      toolMap: new Map()
    };
  }
};

const invokeMcpCalls = async ({ calls, mcpServerUrl }) => {
  if (!Array.isArray(calls) || !calls.length) {
    return { blocks: [], summary: { requested: 0, executed: 0, failed: 0, availableTools: 0 } };
  }

  const runtime = await getMcpRuntime(mcpServerUrl);
  if (!runtime) {
    return {
      blocks: ["MCP tool calls were requested, but no MCP server URL was configured."],
      summary: { requested: calls.length, executed: 0, failed: calls.length, availableTools: 0 }
    };
  }

  if (runtime.loadError) {
    return {
      blocks: [runtime.loadError],
      summary: {
        requested: calls.length,
        executed: 0,
        failed: calls.length,
        availableTools: Array.isArray(runtime.tools) ? runtime.tools.length : 0
      }
    };
  }

  const blocks = [];
  let executed = 0;
  let failed = 0;

  for (const call of calls) {
    const tool = runtime.toolMap.get(call.toolName);
    if (!tool) {
      failed += 1;
      blocks.push(`Tool '${call.toolName}' is not available on MCP server.`);
      continue;
    }

    try {
      const result = await tool.invoke(call.args || {});
      executed += 1;
      blocks.push(`Tool '${call.toolName}' result: ${normalizeToolResult(result)}`);
    } catch (error) {
      failed += 1;
      blocks.push(`Tool '${call.toolName}' failed: ${toString(error?.message || error)}`);
    }
  }

  return {
    blocks,
    summary: {
      requested: calls.length,
      executed,
      failed,
      availableTools: runtime.tools.length
    }
  };
};

const renderSmartEnvelope = ({ smartMode, ragContext, toolHints, jsonSchema, memoryWindow }) => {
  const hints = toToolHints(toolHints);
  const envelope = {
    route: "mcp-only",
    smart_mode: typeof smartMode === "string" ? smartMode : "balanced",
    rag_context: toString(ragContext).trim(),
    tool_hints: hints,
    json_schema: toString(jsonSchema).trim(),
    memory_window: Number(memoryWindow) > 0 ? Number(memoryWindow) : 6
  };

  return JSON.stringify(envelope);
};

export const buildAgentMessage = async ({
  agentId,
  text,
  smartMode,
  ragContext,
  toolHints,
  jsonSchema,
  memoryWindow,
  memory,
  mcpServerUrl,
  enableMcpToolCalls = true
}) => {
  const startedAt = Date.now();

  const parsedInput = parseJsonOrNull(text);
  const extracted =
    parsedInput && typeof parsedInput === "object"
      ? toString(parsedInput.prompt || parsedInput.message || text)
      : toString(text);
  let message = await template.format({ text: extracted });
  const smartEnvelope = renderSmartEnvelope({
    smartMode,
    ragContext,
    toolHints,
    jsonSchema,
    memoryWindow
  });

  const requestedMcpCalls = extractMcpCalls(parsedInput);
  const mcpCallResult = enableMcpToolCalls
    ? await invokeMcpCalls({ calls: requestedMcpCalls, mcpServerUrl })
    : { blocks: [], summary: { requested: requestedMcpCalls.length, executed: 0, failed: 0, availableTools: 0 } };

  if (mcpCallResult.blocks.length) {
    message = `${message}\n\n[MCP_TOOL_RESULTS]\n${mcpCallResult.blocks.join("\n")}\n[/MCP_TOOL_RESULTS]`;
  }

  return {
    message,
    trace: {
      chain: "agentMessageChain",
      elapsedMs: Date.now() - startedAt,
      inputLength: toString(text).length,
      outputLength: message.length,
      smartCapabilities: {
        route: "mcp-only",
        planning: true,
        memory: true,
        structuredJsonInput: true,
        rag: true
      },
      smartEnvelope,
      mcpToolCalls: mcpCallResult.summary,
      memorySize: Array.isArray(memory) ? memory.length : 0,
      agentId: agentId ?? "unknown-agent"
    }
  };
};

export const runLangchainSmokeTest = async () => {
  const sample = {
    agentId: "smoke-agent",
    text: "langchain smoke test"
  };

  const result = await buildAgentMessage(sample);

  return {
    ok: result.message === sample.text,
    expected: sample.text,
    actual: result.message,
    trace: result.trace
  };
};

export const getLangchainFeatureSet = () => {
  return {
    promptTemplate,
    route: "mcp-only",
    features: [
      "PromptTemplate",
      "optional direct MCP tool calls via @langchain/mcp-adapters",
      "supports structured mcp_calls payload in agent text",
      "all reasoning/planning/rag/memory handled by MCP"
    ]
  };
};
