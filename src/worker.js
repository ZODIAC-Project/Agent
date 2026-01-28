import "dotenv/config";
import { Worker } from "bullmq";
import { agentQueue } from "./queue.js";

const mcpClientUrl = process.env.MCP_CLIENT_URL;

const worker = new Worker(
  "agent-queue",
  async (job) => {
    const { agentId, text } = job.data;

    const payload = {
      agentId,
      text,
      ts: Date.now()
    };

    const res = await fetch(mcpClientUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`MCP client error: ${res.status} ${body}`);
    }
  },
  { connection: agentQueue.opts.connection }
);

worker.on("failed", (job, err) => {
  console.error("job failed", job?.id, err.message);
});
