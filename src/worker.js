import "dotenv/config";
import { Worker } from "bullmq";
import { agentQueue } from "./queue.js";

const mcpClientUrl = process.env.MCP_CLIENT_URL;

const normalizeBase = (value) => (value.endsWith("/") ? value.slice(0, -1) : value);
const normalizePath = (value) => (value.startsWith("/") ? value : `/${value}`);

const resolveChatUrl = (jobData) => {
  if (jobData?.chatApiBase) {
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

    const payload = {
      message: text,
      session_id: agentId,
      ts: Date.now()
    };

    console.log("job start", new Date().toISOString(), job.id, { agentId, text });

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
