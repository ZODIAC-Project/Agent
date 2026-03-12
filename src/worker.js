import "dotenv/config";
import { Worker } from "bullmq";
import crypto from "crypto";
import { agentQueue, redis } from "./queue.js";
import { buildAgentMessage } from "./langchain.js";

const mcpClientUrl = process.env.MCP_CLIENT_URL;
const mcpServerUrl = process.env.MCP_SERVER_URL;
const AGENT_HISTORY_PREFIX = "agent:history:";
const AGENT_HISTORY_MAX = Number(process.env.AGENT_HISTORY_MAX || 200);
const AGENT_HASH = "agents";
const AGENT_SPAWN_STATE_PREFIX = "agent:spawned:";

const normalizeBase = (value) => (value.endsWith("/") ? value.slice(0, -1) : value);
const normalizePath = (value) => (value.startsWith("/") ? value : `/${value}`);
const isAbsoluteUrl = (value) => /^https?:\/\//i.test(value);
const preview = (value, size = 80) =>
  value.length <= size ? value : `${value.slice(0, size)}...`;

const historyKey = (agentId) => `${AGENT_HISTORY_PREFIX}${agentId}`;
const spawnStateKey = (agentId) => `${AGENT_SPAWN_STATE_PREFIX}${agentId}`;
const parseJsonOrNull = (value) => {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const toSafeInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
};

const clampMaxDepth = (value) => {
  const parsed = toSafeInt(value, 2);
  return Math.min(Math.max(parsed, 0), 8);
};

const normalizeSpawnAgent = (item) => {
  if (!item || typeof item !== "object") return null;
  const runOnce = item.runOnce === true || String(item.runOnce || "").toLowerCase() === "true";
  const intervalMs = Number(item.intervalMs);
  const text = typeof item.text === "string" ? item.text.trim() : "";
  if (!text || (!runOnce && (!intervalMs || intervalMs < 1000))) return null;

  const toStringList = (value) =>
    Array.isArray(value)
      ? value.map((entry) => String(entry).trim()).filter(Boolean)
      : typeof value === "string"
        ? value.split(",").map((entry) => entry.trim()).filter(Boolean)
        : [];

  return {
    intervalMs: runOnce ? null : intervalMs,
    runOnce,
    text,
    chatApiBase: typeof item.chatApiBase === "string" ? item.chatApiBase : "",
    chatApiPath: typeof item.chatApiPath === "string" ? item.chatApiPath : "",
    purposes: toStringList(item.purposes),
    smartMode: typeof item.smartMode === "string" ? item.smartMode : "balanced",
    ragContext: typeof item.ragContext === "string" ? item.ragContext : "",
    toolHints: toStringList(item.toolHints),
    jsonSchema: typeof item.jsonSchema === "string" ? item.jsonSchema : "",
    memoryWindow: Number(item.memoryWindow) > 0 ? Number(item.memoryWindow) : 6,
    handoffTargets: toStringList(item.handoffTargets),
    maxHandoffDepth: clampMaxDepth(item.maxHandoffDepth)
  };
};

const createChildAgent = async (parentAgentId, spec) => {
  const normalized = normalizeSpawnAgent(spec);
  if (!normalized) {
    return { ok: false, reason: "invalid child spec" };
  }

  const childAgentId = crypto.randomUUID();

  await agentQueue.add(
    "agent",
    {
      agentId: childAgentId,
      runOnce: normalized.runOnce,
      text: normalized.text,
      chatApiBase: normalized.chatApiBase,
      chatApiPath: normalized.chatApiPath,
      purposes: normalized.purposes,
      smartMode: normalized.smartMode,
      ragContext: normalized.ragContext,
      toolHints: normalized.toolHints,
      jsonSchema: normalized.jsonSchema,
      memoryWindow: normalized.memoryWindow,
      handoffTargets: normalized.handoffTargets,
      maxHandoffDepth: normalized.maxHandoffDepth,
      parentAgentId,
      handoffDepth: 0
    },
    normalized.runOnce
      ? { jobId: `once:${childAgentId}:${Date.now()}` }
      : {
          jobId: childAgentId,
          repeat: { every: normalized.intervalMs }
        }
  );

  await redis.hset(
    AGENT_HASH,
    childAgentId,
    JSON.stringify({
      intervalMs: normalized.runOnce ? null : normalized.intervalMs,
      runOnce: normalized.runOnce,
      text: normalized.text,
      chatApiBase: normalized.chatApiBase,
      chatApiPath: normalized.chatApiPath,
      purposes: normalized.purposes,
      smartMode: normalized.smartMode,
      ragContext: normalized.ragContext,
      toolHints: normalized.toolHints,
      jsonSchema: normalized.jsonSchema,
      memoryWindow: normalized.memoryWindow,
      handoffTargets: normalized.handoffTargets,
      spawnAgents: [],
      maxHandoffDepth: normalized.maxHandoffDepth,
      parentAgentId
    })
  );

  return { ok: true, childAgentId };
};

const extractDynamicHandoffTargets = (value) => {
  const parsed = parseJsonOrNull(value);
  if (!parsed || typeof parsed !== "object") return [];
  const rawTargets = Array.isArray(parsed.handoff_targets) ? parsed.handoff_targets : [];
  return rawTargets.map((entry) => String(entry).trim()).filter(Boolean);
};

const extractDynamicSpawnAgents = (value) => {
  // 1) structured mode: { "spawn_agents": [ ... ] }
  const parsed = parseJsonOrNull(value);
  if (parsed && typeof parsed === "object") {
    const raw = Array.isArray(parsed.spawn_agents) ? parsed.spawn_agents : [];
    const normalized = raw.map((item) => normalizeSpawnAgent(item)).filter(Boolean);
    if (normalized.length) return normalized;
  }

  // 2) plain-text mode: "Unterthread 1: ... Unterthread 2: ..."
  if (typeof value !== "string") return [];

  const markerPattern =
    /(unterthread|subthread|child|teilaufgabe|subtask)\s*\d*\s*:\s*([\s\S]*?)(?=(unterthread|subthread|child|teilaufgabe|subtask)\s*\d*\s*:|$)/gi;

  const extracted = [];
  let match;
  while ((match = markerPattern.exec(value)) !== null) {
    const taskText = String(match[2] || "").trim();
    if (!taskText) continue;

    const normalized = normalizeSpawnAgent({
      runOnce: true,
      text: taskText
    });
    if (normalized) extracted.push(normalized);
  }

  return extracted;
};

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
      purposes,
      handoffTargets,
      spawnAgents,
      maxHandoffDepth,
      handoffDepth,
      parentAgentId,
      handoffFromAgentId,
      handoffReason
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

    const staticHandoffTargets = Array.isArray(handoffTargets)
      ? handoffTargets.map((entry) => String(entry).trim()).filter(Boolean)
      : [];
    const dynamicHandoffTargets = extractDynamicHandoffTargets(text);
    const mergedHandoffTargets = [...new Set([...staticHandoffTargets, ...dynamicHandoffTargets])];

    const inheritHandoffTargets = (spec) => {
      if (!spec || typeof spec !== "object") return spec;
      if (Array.isArray(spec.handoffTargets) && spec.handoffTargets.length) return spec;
      if (!mergedHandoffTargets.length) return spec;
      return { ...spec, handoffTargets: [...mergedHandoffTargets] };
    };

    const staticSpawnAgents = Array.isArray(spawnAgents)
      ? spawnAgents.map((item) => normalizeSpawnAgent(item)).filter(Boolean).map(inheritHandoffTargets)
      : [];
    // Only root/orchestrator jobs should derive child spawns from free text markers
    // like "Unterthread 1:". Forwarded handoff jobs must not spawn again.
    const allowTextDerivedSpawn = !handoffFromAgentId;
    const dynamicSpawnAgents = allowTextDerivedSpawn
      ? extractDynamicSpawnAgents(text).map(inheritHandoffTargets)
      : [];
    const mergedSpawnAgents = [...staticSpawnAgents, ...dynamicSpawnAgents];

    const currentDepth = Number(handoffDepth) >= 0 ? Number(handoffDepth) : 0;
    const depthLimit = clampMaxDepth(maxHandoffDepth);

    let spawnedChildren = [];
    let spawnSkippedAlreadyInitialized = false;
    if (mergedSpawnAgents.length > 0) {
      const stateKey = spawnStateKey(agentId);
      const rawSpawnState = await redis.get(stateKey);

      if (rawSpawnState) {
        spawnSkippedAlreadyInitialized = true;
        const parsedSpawnState = parseJsonOrNull(rawSpawnState);
        if (parsedSpawnState && Array.isArray(parsedSpawnState.children)) {
          spawnedChildren = parsedSpawnState.children.map((entry) => String(entry)).filter(Boolean);
        }
      } else {
        const spawnResults = await Promise.all(
          mergedSpawnAgents.map((spec) => createChildAgent(agentId, spec))
        );
        spawnedChildren = spawnResults
          .filter((result) => result.ok)
          .map((result) => result.childAgentId);

        await redis.set(
          stateKey,
          JSON.stringify({
            initializedAt: new Date().toISOString(),
            requested: mergedSpawnAgents.length,
            children: spawnedChildren
          })
        );
      }
    }

    const handoffSummary = {
      requested: mergedHandoffTargets.length,
      enqueued: 0,
      skippedDepth: false
    };

    if (mergedHandoffTargets.length > 0) {
      if (currentDepth >= depthLimit) {
        handoffSummary.skippedDepth = true;
      } else {
        const nextDepth = currentDepth + 1;
        for (const targetAgentId of mergedHandoffTargets) {
          if (!targetAgentId || targetAgentId === agentId) continue;

          const targetRaw = await redis.hget(AGENT_HASH, targetAgentId);
          if (!targetRaw) continue;

          let targetConfig = null;
          try {
            targetConfig = JSON.parse(targetRaw);
          } catch {
            targetConfig = null;
          }
          if (!targetConfig || typeof targetConfig !== "object") continue;

          const forwardedText = JSON.stringify({
            prompt: message,
            handoff_from: agentId,
            source_job_id: String(job.id || "")
          });

          await agentQueue.add("agent", {
            agentId: targetAgentId,
            text: forwardedText,
            chatApiBase: targetConfig.chatApiBase,
            chatApiPath: targetConfig.chatApiPath,
            purposes: Array.isArray(targetConfig.purposes) ? targetConfig.purposes : [],
            smartMode: targetConfig.smartMode || "balanced",
            ragContext: typeof targetConfig.ragContext === "string" ? targetConfig.ragContext : "",
            toolHints: Array.isArray(targetConfig.toolHints) ? targetConfig.toolHints : [],
            jsonSchema: typeof targetConfig.jsonSchema === "string" ? targetConfig.jsonSchema : "",
            memoryWindow: Number(targetConfig.memoryWindow) > 0 ? Number(targetConfig.memoryWindow) : 6,
            handoffTargets: Array.isArray(targetConfig.handoffTargets) ? targetConfig.handoffTargets : [],
            spawnAgents: Array.isArray(targetConfig.spawnAgents) ? targetConfig.spawnAgents : [],
            maxHandoffDepth: clampMaxDepth(targetConfig.maxHandoffDepth),
            handoffDepth: nextDepth,
            handoffFromAgentId: agentId,
            handoffReason: "forwarded-result"
          });

          handoffSummary.enqueued += 1;
        }
      }
    }

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
        mcpToolCalls: trace?.mcpToolCalls || null,
        orchestration: {
          spawnedChildren,
          spawnSkippedAlreadyInitialized,
          handoff: handoffSummary,
          handoffDepth: currentDepth,
          parentAgentId: parentAgentId || null,
          handoffFromAgentId: handoffFromAgentId || null,
          handoffReason: handoffReason || null
        }
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
          mcpToolCalls: trace?.mcpToolCalls || null,
          orchestration: {
            spawnSkippedAlreadyInitialized,
            handoffDepth: currentDepth,
            parentAgentId: parentAgentId || null,
            handoffFromAgentId: handoffFromAgentId || null,
            handoffReason: handoffReason || null
          }
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
