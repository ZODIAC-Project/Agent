import "dotenv/config";
import { Worker } from "bullmq";
import { agentQueue } from "./queue.js";
import { buildAgentMessage } from "./langchain.js";

const mcpClientUrl = process.env.MCP_CLIENT_URL;

const normalizeBase = (value) => (value.endsWith("/") ? value.slice(0, -1) : value);
const normalizePath = (value) => (value.startsWith("/") ? value : `/${value}`);
const isAbsoluteUrl = (value) => /^https?:\/\//i.test(value);
const preview = (value, size = 80) =>
  value.length <= size ? value : `${value.slice(0, size)}...`;

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
    const { agentId, text } = job.data;
    const { message, trace } = await buildAgentMessage({ agentId, text });

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

    console.log("job ok", new Date().toISOString(), job.id, res.status);
  },
  { connection: agentQueue.opts.connection }
);

worker.on("failed", (job, err) => {
  console.error("job failed", job?.id, err.message);
});
