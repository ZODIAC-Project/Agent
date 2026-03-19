import "dotenv/config";
import "./telemetry.js";
import express from "express";
import crypto from "crypto";
import { agentQueue, redis } from "./queue.js";
import { getLangchainFeatureSet } from "./langchain.js";
import { metrics } from "@opentelemetry/api";

const app = express();
app.use(express.json());

const AGENT_HASH = "agents";
const AGENT_HISTORY_PREFIX = "agent:history:";
const AGENT_SPAWN_STATE_PREFIX = "agent:spawned:";

const meter = metrics.getMeter("agent-api");
const agentCreateCounter = meter.createCounter("agent_create_total", {
  description: "Number of agents created via API"
});

const getAgentHistoryKey = (agentId) => `${AGENT_HISTORY_PREFIX}${agentId}`;
const getAgentSpawnStateKey = (agentId) => `${AGENT_SPAWN_STATE_PREFIX}${agentId}`;

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
    runOnce,
    noTools,
    text,
    chatApiBase,
    chatApiPath,
    purposes,
    smartMode,
    ragContext,
    toolHints,
    jsonSchema,
    memoryWindow,
    handoffTargets,
    spawnAgents,
    maxHandoffDepth
  } = req.body || {};
  const normalizedRunOnce = runOnce === true || String(runOnce || "").toLowerCase() === "true";
  const normalizedNoTools = noTools === true || String(noTools || "").toLowerCase() === "true";
  const normalizedIntervalMs = Number(intervalMs);
  if (!text || (!normalizedRunOnce && (!normalizedIntervalMs || normalizedIntervalMs < 1000))) {
    return res.status(400).json({ error: "text erforderlich, und entweder runOnce=true oder intervalMs >= 1000" });
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
  const normalizedHandoffTargets = Array.isArray(handoffTargets)
    ? handoffTargets.map((item) => String(item).trim()).filter(Boolean)
    : typeof handoffTargets === "string"
      ? handoffTargets.split(",").map((item) => item.trim()).filter(Boolean)
      : [];
  const normalizedMaxHandoffDepth = Number(maxHandoffDepth) >= 0 ? Number(maxHandoffDepth) : 2;
  const normalizedSpawnAgents = Array.isArray(spawnAgents)
    ? spawnAgents
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const childRunOnce =
            item.runOnce === true || String(item.runOnce || "").toLowerCase() === "true";
          const childIntervalMs = Number(item.intervalMs);
          const childText = typeof item.text === "string" ? item.text : "";
          if (!childText || (!childRunOnce && (!childIntervalMs || childIntervalMs < 1000))) return null;

          return {
            intervalMs: childRunOnce ? null : childIntervalMs,
            runOnce: childRunOnce,
            noTools:
              item.noTools === true || String(item.noTools || "").toLowerCase() === "true",
            text: childText,
            chatApiBase: typeof item.chatApiBase === "string" ? item.chatApiBase : "",
            chatApiPath: typeof item.chatApiPath === "string" ? item.chatApiPath : "",
            purposes: Array.isArray(item.purposes)
              ? item.purposes.map((entry) => String(entry).trim()).filter(Boolean)
              : typeof item.purposes === "string"
                ? item.purposes.split(",").map((entry) => entry.trim()).filter(Boolean)
                : [],
            smartMode: typeof item.smartMode === "string" ? item.smartMode : "balanced",
            ragContext: typeof item.ragContext === "string" ? item.ragContext : "",
            toolHints: Array.isArray(item.toolHints)
              ? item.toolHints.map((entry) => String(entry).trim()).filter(Boolean)
              : typeof item.toolHints === "string"
                ? item.toolHints.split(",").map((entry) => entry.trim()).filter(Boolean)
                : [],
            jsonSchema: typeof item.jsonSchema === "string" ? item.jsonSchema : "",
            memoryWindow: Number(item.memoryWindow) > 0 ? Number(item.memoryWindow) : 6,
            handoffTargets: Array.isArray(item.handoffTargets)
              ? item.handoffTargets.map((entry) => String(entry).trim()).filter(Boolean)
              : typeof item.handoffTargets === "string"
                ? item.handoffTargets.split(",").map((entry) => entry.trim()).filter(Boolean)
                : []
          };
        })
        .filter(Boolean)
    : [];

  await agentQueue.add(
    "agent",
    {
      agentId,
      runOnce: normalizedRunOnce,
      noTools: normalizedNoTools,
      text,
      chatApiBase,
      chatApiPath,
      purposes: normalizedPurposes,
      smartMode: normalizedSmartMode,
      ragContext: normalizedRagContext,
      toolHints: normalizedToolHints,
      jsonSchema: normalizedJsonSchema,
      memoryWindow: normalizedMemoryWindow,
      handoffTargets: normalizedHandoffTargets,
      spawnAgents: normalizedSpawnAgents,
      maxHandoffDepth: normalizedMaxHandoffDepth
    },
    normalizedRunOnce
      ? { jobId: `once:${agentId}:${Date.now()}` }
      : {
          jobId: agentId,
          repeat: { every: normalizedIntervalMs }
        }
  );

  await redis.hset(
    AGENT_HASH,
    agentId,
    JSON.stringify({
      intervalMs: normalizedRunOnce ? null : normalizedIntervalMs,
      runOnce: normalizedRunOnce,
      noTools: normalizedNoTools,
      text,
      chatApiBase,
      chatApiPath,
      purposes: normalizedPurposes,
      smartMode: normalizedSmartMode,
      ragContext: normalizedRagContext,
      toolHints: normalizedToolHints,
      jsonSchema: normalizedJsonSchema,
      memoryWindow: normalizedMemoryWindow,
      handoffTargets: normalizedHandoffTargets,
      spawnAgents: normalizedSpawnAgents,
      maxHandoffDepth: normalizedMaxHandoffDepth
    })
  );

  res.status(201).json({
    agentId,
    intervalMs: normalizedRunOnce ? null : normalizedIntervalMs,
    runOnce: normalizedRunOnce,
    noTools: normalizedNoTools,
    text,
    chatApiBase,
    chatApiPath,
    purposes: normalizedPurposes,
    smartMode: normalizedSmartMode,
    ragContext: normalizedRagContext,
    toolHints: normalizedToolHints,
    jsonSchema: normalizedJsonSchema,
    memoryWindow: normalizedMemoryWindow,
    handoffTargets: normalizedHandoffTargets,
    spawnAgents: normalizedSpawnAgents,
    maxHandoffDepth: normalizedMaxHandoffDepth
  });
  agentCreateCounter.add(1, {
    run_once: normalizedRunOnce ? "true" : "false",
    smart_mode: normalizedSmartMode
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

  if (!rawAgent && history.length === 0) return res.status(404).json({ error: "not found" });

  res.json({ agentId, history });
});

app.delete("/agents/:agentId", async (req, res) => {
  const { agentId } = req.params;
  const raw = await redis.hget(AGENT_HASH, agentId);
  if (!raw) return res.status(404).json({ error: "not found" });

  const { intervalMs, runOnce } = JSON.parse(raw);
  if (!runOnce && Number(intervalMs) >= 1000) {
    await agentQueue.removeRepeatable("agent", { every: Number(intervalMs), jobId: agentId });
  }
  await redis.hdel(AGENT_HASH, agentId);
  await redis.del(getAgentHistoryKey(agentId));
  await redis.del(getAgentSpawnStateKey(agentId));
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`agent api listening on ${port}`);
});
