import "dotenv/config";
import { Worker } from "bullmq";
import { agentQueue, redis } from "./queue.js";
import { buildAgentMessage } from "./langchain.js";

const mcpClientUrl = process.env.MCP_CLIENT_URL;
const mcpServerUrl = process.env.MCP_SERVER_URL;
const AGENT_HISTORY_PREFIX = "agent:history:";
const AGENT_HISTORY_MAX = Number(process.env.AGENT_HISTORY_MAX || 200);

const normalizeBase = (value) => (value.endsWith("/") ? value.slice(0, -1) : value);
const normalizePath = (value) => (value.startsWith("/") ? value : `/${value}`);
const isAbsoluteUrl = (value) => /^https?:\/\//i.test(value);
const preview = (value, size = 80) =>
  value.length <= size ? value : `${value.slice(0, size)}...`;

const historyKey = (agentId) => `${AGENT_HISTORY_PREFIX}${agentId}`;

const pushAgentHistory = async (agentId, entry) => {
  if (!agentId) return;
  const key = historyKey(agentId);
  await redis.rpush(key, JSON.stringify(entry));
  await redis.ltrim(key, -AGENT_HISTORY_MAX, -1);
};

const normalizeResponseText = (rawText) => {
  const value = String(rawText || "").trim();
  if (!value) return "";
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && typeof parsed.response === "string") {
      return parsed.response;
    }
    return value;
  } catch {
    return value;
  }
};

const resolveChatUrl = (jobData) => {
  if (jobData?.chatApiBase && isAbsoluteUrl(jobData.chatApiBase)) {
    const base = normalizeBase(jobData.chatApiBase);
    const path = jobData.chatApiPath ? normalizePath(jobData.chatApiPath) : "";
    return `${base}${path}`;
  }
  return mcpClientUrl;
};

const worker = new Worker(
  "agent-queue",
  async (job) => {
    const {
      agentId,
      text,
      smartMode,
      ragContext,
      toolHints,
      jsonSchema,
      memoryWindow,
      purposes
    } = job.data;

    const { message, trace } = await buildAgentMessage({
      agentId,
      text,
      smartMode,
      ragContext,
      toolHints,
      jsonSchema,
      memoryWindow,
      memory: [],
      mcpServerUrl,
      enableMcpToolCalls: true
    });

    const payload = {
      message,
      session_id: agentId,
      purposes: Array.isArray(purposes) ? purposes : [],
      smart_mode: smartMode || "balanced",
      rag_context: typeof ragContext === "string" ? ragContext : "",
      tool_hints: Array.isArray(toolHints) ? toolHints : [],
      json_schema: typeof jsonSchema === "string" ? jsonSchema : "",
      memory_window: Number(memoryWindow) > 0 ? Number(memoryWindow) : 6
    };

    console.log("job start", new Date().toISOString(), job.id, {
      agentId,
      text,
      messageLength: message.length,
      messagePreview: preview(message),
      langchain: trace
    });

    const startedAt = new Date().toISOString();
    const chatUrl = resolveChatUrl(job.data);
    try {
      const res = await fetch(chatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const bodyText = await res.text();

      if (!res.ok) {
        throw new Error(`MCP client error: ${res.status} ${bodyText}`);
      }

      await pushAgentHistory(agentId, {
        timestamp: startedAt,
        jobId: String(job.id || ""),
        status: "ok",
        text: String(text || ""),
        message: preview(message, 400),
        response: preview(normalizeResponseText(bodyText), 2000),
        mcpToolCalls: trace?.mcpToolCalls || null
      });

      console.log("job ok", new Date().toISOString(), job.id, res.status);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      try {
        await pushAgentHistory(agentId, {
          timestamp: startedAt,
          jobId: String(job.id || ""),
          status: "error",
          text: String(text || ""),
          message: preview(message, 400),
          error: preview(messageText, 2000),
          mcpToolCalls: trace?.mcpToolCalls || null
        });
      } catch (historyError) {
        console.error("failed to persist agent history", historyError);
      }
      throw error;
    }
  },
  { connection: agentQueue.opts.connection }
);

worker.on("failed", (job, err) => {
  console.error("job failed", job?.id, err.message);
});
