import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { agentQueue, redis } from "./queue.js";
import { getLangchainFeatureSet } from "./langchain.js";

const app = express();
app.use(express.json());

const AGENT_HASH = "agents";
const AGENT_HISTORY_PREFIX = "agent:history:";

const getAgentHistoryKey = (agentId) => `${AGENT_HISTORY_PREFIX}${agentId}`;

const toSafeInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
};

app.get("/langchain/features", (_req, res) => {
  res.json(getLangchainFeatureSet());
});

app.post("/agents", async (req, res) => {
  const {
    intervalMs,
    text,
    chatApiBase,
    chatApiPath,
    purposes,
    smartMode,
    ragContext,
    toolHints,
    jsonSchema,
    memoryWindow
  } = req.body || {};
  if (!intervalMs || !text || intervalMs < 1000) {
    return res.status(400).json({ error: "intervalMs >= 1000 und text erforderlich" });
  }

  const agentId = crypto.randomUUID();
  const normalizedSmartMode = typeof smartMode === "string" ? smartMode : "balanced";
  const normalizedPurposes = Array.isArray(purposes)
    ? purposes.map((item) => String(item).trim()).filter(Boolean)
    : typeof purposes === "string"
      ? purposes.split(",").map((item) => item.trim()).filter(Boolean)
      : [];
  const normalizedRagContext = typeof ragContext === "string" ? ragContext : "";
  const normalizedToolHints = Array.isArray(toolHints)
    ? toolHints.map((item) => String(item).trim()).filter(Boolean)
    : typeof toolHints === "string"
      ? toolHints.split(",").map((item) => item.trim()).filter(Boolean)
      : [];
  const normalizedJsonSchema = typeof jsonSchema === "string" ? jsonSchema : "";
  const normalizedMemoryWindow = Number(memoryWindow) > 0 ? Number(memoryWindow) : 6;

  await agentQueue.add(
    "agent",
    {
      agentId,
      text,
      chatApiBase,
      chatApiPath,
      purposes: normalizedPurposes,
      smartMode: normalizedSmartMode,
      ragContext: normalizedRagContext,
      toolHints: normalizedToolHints,
      jsonSchema: normalizedJsonSchema,
      memoryWindow: normalizedMemoryWindow
    },
    {
      jobId: agentId,
      repeat: { every: intervalMs }
    }
  );

  await redis.hset(
    AGENT_HASH,
    agentId,
    JSON.stringify({
      intervalMs,
      text,
      chatApiBase,
      chatApiPath,
      purposes: normalizedPurposes,
      smartMode: normalizedSmartMode,
      ragContext: normalizedRagContext,
      toolHints: normalizedToolHints,
      jsonSchema: normalizedJsonSchema,
      memoryWindow: normalizedMemoryWindow
    })
  );
  res.status(201).json({
    agentId,
    intervalMs,
    text,
    chatApiBase,
    chatApiPath,
    purposes: normalizedPurposes,
    smartMode: normalizedSmartMode,
    ragContext: normalizedRagContext,
    toolHints: normalizedToolHints,
    jsonSchema: normalizedJsonSchema,
    memoryWindow: normalizedMemoryWindow
  });
});

app.get("/agents", async (_req, res) => {
  const all = await redis.hgetall(AGENT_HASH);
  const agents = Object.entries(all).map(([agentId, value]) => ({
    agentId,
    ...JSON.parse(value)
  }));
  res.json(agents);
});

app.get("/agents/:agentId/history", async (req, res) => {
  const { agentId } = req.params;
  const rawAgent = await redis.hget(AGENT_HASH, agentId);
  if (!rawAgent) return res.status(404).json({ error: "not found" });

  const requestedLimit = toSafeInt(req.query.limit, 50);
  const limit = Math.min(Math.max(requestedLimit, 1), 500);

  const key = getAgentHistoryKey(agentId);
  const rows = await redis.lrange(key, -limit, -1);
  const history = rows
    .map((row) => {
      try {
        return JSON.parse(row);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();

  res.json({ agentId, history });
});

app.delete("/agents/:agentId", async (req, res) => {
  const { agentId } = req.params;
  const raw = await redis.hget(AGENT_HASH, agentId);
  if (!raw) return res.status(404).json({ error: "not found" });

  const { intervalMs } = JSON.parse(raw);
  await agentQueue.removeRepeatable("agent", { every: intervalMs, jobId: agentId });
  await redis.hdel(AGENT_HASH, agentId);
  await redis.del(getAgentHistoryKey(agentId));
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`agent api listening on ${port}`);
});
