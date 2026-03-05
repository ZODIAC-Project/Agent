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
  memory
}) => {
  const startedAt = Date.now();

  const parsedInput = parseJsonOrNull(text);
  const extracted =
    parsedInput && typeof parsedInput === "object"
      ? toString(parsedInput.prompt || parsedInput.message || text)
      : toString(text);
  const message = await template.format({ text: extracted });
  const smartEnvelope = renderSmartEnvelope({
    smartMode,
    ragContext,
    toolHints,
    jsonSchema,
    memoryWindow
  });

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
      "agent-side pass-through only",
      "all reasoning/planning/rag/memory handled by MCP"
    ]
  };
};
