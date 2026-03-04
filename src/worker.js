import "dotenv/config";
import { Worker } from "bullmq";
import { agentQueue, redis } from "./queue.js";
import { buildAgentMessage } from "./langchain.js";

const mcpClientUrl = process.env.MCP_CLIENT_URL;

const normalizeBase = (value) => (value.endsWith("/") ? value.slice(0, -1) : value);
const normalizePath = (value) => (value.startsWith("/") ? value : `/${value}`);
const isAbsoluteUrl = (value) => /^https?:\/\//i.test(value);
const preview = (value, size = 80) =>
  value.length <= size ? value : `${value.slice(0, size)}...`;
const MAX_MEMORY_ITEMS = Number(process.env.AGENT_MEMORY_MAX_ITEMS || "40");

const memoryKey = (agentId) => `agent-memory:${agentId}`;

const loadMemory = async (agentId, memoryWindow = 6) => {
  const max = Number(memoryWindow) > 0 ? Number(memoryWindow) : 6;
  const rows = await redis.lrange(memoryKey(agentId), 0, Math.max(max - 1, 0));
  return rows
    .map((row) => {
      try {
        return JSON.parse(row);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};

const saveMemory = async (agentId, entry) => {
  await redis.lpush(memoryKey(agentId), JSON.stringify(entry));
  await redis.ltrim(memoryKey(agentId), 0, Math.max(MAX_MEMORY_ITEMS - 1, 0));
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
      memoryWindow
    } = job.data;
    const memory = await loadMemory(agentId, memoryWindow);

    const { message, trace } = await buildAgentMessage({
      agentId,
      text,
      smartMode,
      ragContext,
      toolHints,
      jsonSchema,
      memoryWindow,
      memory
    });

    const payload = {
      message,
      session_id: agentId
    };

    console.log("job start", new Date().toISOString(), job.id, {
      agentId,
      text,
      messageLength: message.length,
      messagePreview: preview(message),
      langchain: trace
    });

    const chatUrl = resolveChatUrl(job.data);
    const res = await fetch(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`MCP client error: ${res.status} ${body}`);
    }

    await saveMemory(agentId, {
      at: new Date().toISOString(),
      input: text,
      output: message,
      mode: smartMode || "balanced"
    });

    console.log("job ok", new Date().toISOString(), job.id, res.status);
  },
  { connection: agentQueue.opts.connection }
);

worker.on("failed", (job, err) => {
  console.error("job failed", job?.id, err.message);
});
