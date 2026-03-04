import { ChatPromptTemplate, PromptTemplate } from "@langchain/core/prompts";
import { JsonOutputParser, StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableLambda, RunnableSequence } from "@langchain/core/runnables";
import { ChatOllama } from "@langchain/ollama";

const promptTemplate = "{text}";
const llmBaseUrl = process.env.AGENT_LLM_URL || process.env.LLM_URL || "http://host.minikube.internal:11434";
const llmModel = process.env.AGENT_LLM_MODEL || process.env.MODEL || "gpt-oss:120b";
const llmTimeoutMs = Number(process.env.AGENT_LLM_TIMEOUT_MS || "2000");
const maxRagSnippets = Number(process.env.AGENT_RAG_TOP_K || "3");

const template = PromptTemplate.fromTemplate(promptTemplate);
const chatTemplate = ChatPromptTemplate.fromMessages([
  [
    "system",
    "You are an MCP-safe preprocessor that rewrites user messages for clarity. Return plain text only and never emit structured arguments, JSON objects, or key-value fields such as tags, agent_id, purposes, or session_id."
  ],
  ["human", "Agent ID: {agentId}\nOriginal message: {text}"]
]);
const outputParser = new StringOutputParser();
const jsonOutputParser = new JsonOutputParser();
const llm = new ChatOllama({
  baseUrl: llmBaseUrl,
  model: llmModel,
  temperature: 0
});

const plannerPrompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    "You are an MCP-safe planning preprocessor. Always return strict JSON only with keys: rewritten_message (string), intent (string), plan_steps (string array), tool_hints (string array), mode (string), notes (string). Never output MCP function arguments or JSON tool call payloads."
  ],
  [
    "human",
    "Agent ID: {agentId}\nMode: {smartMode}\nText: {effectiveText}\nParsed JSON Input: {parsedJsonText}\nRAG Snippets: {ragText}\nMemory: {memoryText}\nTool Hints: {toolHintsText}\nRequested JSON Schema: {jsonSchemaText}"
  ]
]);

const normalizeInput = RunnableLambda.from((input) => {
  const agentId = typeof input?.agentId === "string" ? input.agentId : "unknown-agent";
  const text = typeof input?.text === "string" ? input.text : "";
  const smartMode = typeof input?.smartMode === "string" ? input.smartMode : "balanced";
  const ragContext = typeof input?.ragContext === "string" ? input.ragContext : "";
  const toolHints = input?.toolHints;
  const jsonSchema = typeof input?.jsonSchema === "string" ? input.jsonSchema : "";
  const memoryWindow = Number(input?.memoryWindow || 6);
  const memory = Array.isArray(input?.memory) ? input.memory : [];

  return {
    agentId,
    text,
    smartMode,
    ragContext,
    toolHints,
    jsonSchema,
    memoryWindow,
    memory
  };
});

const finalizeOutput = RunnableLambda.from((value) =>
  typeof value === "string" ? value : String(value ?? "")
);

const ensureStructuredShape = RunnableLambda.from((value) => {
  if (typeof value?.message === "string") {
    return value;
  }

  return {
    message: "",
    mode: "fallback-shape",
    metadata: {
      reason: "missing-message"
    }
  };
});

const parseJsonOrNull = (value) => {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const parseToolHints = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const tokenize = (value) =>
  String(value || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length > 1);

const buildRagSnippets = (query, ragContext, topK) => {
  if (!ragContext?.trim()) return [];
  const chunks = ragContext
    .split(/\n\s*\n|\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!chunks.length) return [];

  const queryTokens = new Set(tokenize(query));
  const scored = chunks.map((chunk) => {
    const chunkTokens = tokenize(chunk);
    const overlap = chunkTokens.reduce(
      (count, token) => count + (queryTokens.has(token) ? 1 : 0),
      0
    );
    return { chunk, score: overlap };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((item) => item.chunk);
};

const extractPlannerJson = (raw) => {
  if (typeof raw !== "string") {
    return null;
  }

  const direct = parseJsonOrNull(raw);
  if (direct && typeof direct === "object") {
    return direct;
  }

  const fencedMatch = raw.match(/```json\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    const parsed = parseJsonOrNull(fencedMatch[1].trim());
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  }

  const firstObj = raw.indexOf("{");
  const lastObj = raw.lastIndexOf("}");
  if (firstObj >= 0 && lastObj > firstObj) {
    const parsed = parseJsonOrNull(raw.slice(firstObj, lastObj + 1));
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  }

  return null;
};

const passthroughFallback = RunnableLambda.from((input) => {
  const text = input?.text;
  return typeof text === "string" ? text : String(text ?? "");
});

const callLlmWithTimeout = RunnableLambda.from(async (input) => {
  const promptValue = await chatTemplate.invoke(input);
  const llmCall = llm.invoke(promptValue).then((value) => outputParser.invoke(value));
  const timeoutCall = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("llm preprocessing timeout")), llmTimeoutMs);
  });

  const llmText = await Promise.race([llmCall, timeoutCall]);
  return typeof llmText === "string" ? llmText : String(llmText ?? "");
});

const prepareSmartContext = RunnableLambda.from((input) => {
  const parsedInputJson = parseJsonOrNull(input.text);
  const jsonPromptText =
    parsedInputJson && typeof parsedInputJson === "object"
      ? String(parsedInputJson.prompt || parsedInputJson.message || "")
      : "";
  const effectiveText = jsonPromptText || input.text;
  const ragSnippets = buildRagSnippets(effectiveText, input.ragContext, maxRagSnippets);
  const toolHints = parseToolHints(input.toolHints);
  const memoryList = Array.isArray(input.memory) ? input.memory : [];

  return {
    ...input,
    effectiveText,
    parsedInputJson,
    ragSnippets,
    toolHints,
    memoryList,
    ragText: ragSnippets.join("\n- "),
    memoryText: memoryList
      .map((entry) => `${entry?.input || ""} -> ${entry?.output || ""}`)
      .join("\n"),
    parsedJsonText: parsedInputJson ? JSON.stringify(parsedInputJson) : "",
    toolHintsText: toolHints.join(", "),
    jsonSchemaText: input.jsonSchema || ""
  };
});

const directPlanFallbackChain = RunnableSequence.from([
  prepareSmartContext,
  RunnableLambda.from((input) => ({
    rewritten_message: input.effectiveText,
    intent: "fallback",
    plan_steps: [],
    tool_hints: input.toolHints,
    mode: input.smartMode,
    notes: "direct fallback without llm planning"
  }))
]).withConfig({
  runName: "agentPlanFallbackChain",
  tags: ["agent", "langchain", "planning-fallback"]
});

const plannerChain = RunnableSequence.from([
  prepareSmartContext,
  RunnableLambda.from(async (input) => {
    const promptValue = await plannerPrompt.invoke(input);
    const llmCall = llm.invoke(promptValue).then((value) => outputParser.invoke(value));
    const timeoutCall = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("llm planner timeout")), llmTimeoutMs);
    });

    const raw = await Promise.race([llmCall, timeoutCall]);
    const parsed = extractPlannerJson(raw);

    return {
      input,
      parsed,
      raw
    };
  }),
  RunnableLambda.from((state) => {
    const fallback = {
      rewritten_message: state.input.effectiveText,
      intent: "fallback",
      plan_steps: [],
      tool_hints: state.input.toolHints,
      mode: state.input.smartMode,
      notes: "planner json parse fallback"
    };
    const parsed = state.parsed && typeof state.parsed === "object" ? state.parsed : fallback;

    return {
      rewritten_message:
        typeof parsed.rewritten_message === "string" && parsed.rewritten_message.trim()
          ? parsed.rewritten_message
          : state.input.effectiveText,
      intent: typeof parsed.intent === "string" ? parsed.intent : "preprocess",
      plan_steps: Array.isArray(parsed.plan_steps) ? parsed.plan_steps : [],
      tool_hints: Array.isArray(parsed.tool_hints) ? parsed.tool_hints : state.input.toolHints,
      mode: typeof parsed.mode === "string" ? parsed.mode : state.input.smartMode,
      notes: typeof parsed.notes === "string" ? parsed.notes : "",
      rag_used: state.input.ragSnippets.length,
      memory_used: state.input.memoryList.length,
      json_input_detected: Boolean(state.input.parsedInputJson)
    };
  })
]).withConfig({
  runName: "agentPlanningChain",
  tags: ["agent", "langchain", "planning"]
});

const resilientPlannerChain = plannerChain
  .withRetry({ stopAfterAttempt: 2 })
  .withFallbacks({ fallbacks: [directPlanFallbackChain] });

const directTextChain = RunnableSequence.from([
  normalizeInput,
  template,
  outputParser,
  finalizeOutput
]).withConfig({
  runName: "agentDirectTextChain",
  tags: ["agent", "langchain", "fallback"]
});

const llmPreprocessChain = RunnableSequence.from([
  normalizeInput,
  prepareSmartContext,
  RunnableLambda.from((input) => ({
    agentId: input.agentId,
    text: input.effectiveText
  })),
  callLlmWithTimeout,
  finalizeOutput
]).withConfig({
  runName: "agentLlmPreprocessChain",
  tags: ["agent", "langchain", "llm"]
});

const resilientMessageChain = llmPreprocessChain
  .withRetry({ stopAfterAttempt: 2 })
  .withFallbacks({ fallbacks: [directTextChain] });

const primaryChain = RunnableSequence.from([
  normalizeInput,
  RunnableLambda.from(async (input) => {
    const [plan, renderedPrompt] = await Promise.all([
      resilientPlannerChain.invoke(input),
      resilientMessageChain.invoke(input)
    ]);

    const finalMessage =
      typeof plan?.rewritten_message === "string" && plan.rewritten_message.trim()
        ? plan.rewritten_message
        : renderedPrompt;

    return {
      message: finalMessage,
      mode: "llm-preprocessed",
      metadata: {
        agentId: input.agentId,
        inputLength: input.text.length,
        smartMode: input.smartMode,
        llmBaseUrl,
        llmModel,
        llmTimeoutMs,
        plan
      }
    };
  }),
  RunnableLambda.from((value) => JSON.stringify(value)),
  jsonOutputParser,
  ensureStructuredShape,
  RunnableLambda.from((value) => value.message),
  outputParser,
  finalizeOutput
]).withConfig({
  runName: "agentMessageChain",
  tags: ["agent", "langchain", "mcp-safe"]
});

const resilientChain = primaryChain
  .withRetry({ stopAfterAttempt: 1 })
  .withFallbacks({ fallbacks: [passthroughFallback] });

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

  const message = await resilientChain.invoke(
    {
      agentId,
      text,
      smartMode,
      ragContext,
      toolHints,
      jsonSchema,
      memoryWindow,
      memory
    },
    {
      metadata: {
        agentId: agentId ?? "unknown-agent"
      }
    }
  );

  return {
    message,
    trace: {
      chain: "agentMessageChain",
      elapsedMs: Date.now() - startedAt,
      inputLength: typeof text === "string" ? text.length : 0,
      outputLength: message.length,
      llm: {
        baseUrl: llmBaseUrl,
        model: llmModel,
        timeoutMs: llmTimeoutMs
      },
      smartCapabilities: {
        ragTopK: maxRagSnippets,
        planning: true,
        memory: true,
        structuredJsonInput: true
      }
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
    llm: {
      baseUrl: llmBaseUrl,
      model: llmModel,
      timeoutMs: llmTimeoutMs
    },
    chatPromptTemplate: [
      "system: MCP-safe rewrite instruction",
      "human: Agent ID + Original message"
    ],
    features: [
      "PromptTemplate",
      "ChatPromptTemplate",
      "ChatOllama",
      "RunnableSequence",
      "JsonOutputParser",
      "StringOutputParser",
      "withRetry",
      "withFallbacks",
      "lightweight RAG retrieval",
      "tool planning before MCP",
      "memory-aware preprocessing",
      "structured JSON input handling",
      "invoke metadata",
      "execution trace"
    ]
  };
};
