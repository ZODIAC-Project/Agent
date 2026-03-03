import { PromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableLambda, RunnableSequence } from "@langchain/core/runnables";

const promptTemplate = "{text}";

const template = PromptTemplate.fromTemplate(promptTemplate);
const outputParser = new StringOutputParser();

const normalizeInput = RunnableLambda.from((input) => {
  const agentId = typeof input?.agentId === "string" ? input.agentId : "unknown-agent";
  const text = typeof input?.text === "string" ? input.text : "";
  return { agentId, text };
});

const finalizeOutput = RunnableLambda.from((value) =>
  typeof value === "string" ? value : String(value ?? "")
);

const passthroughFallback = RunnableLambda.from((input) => {
  const text = input?.text;
  return typeof text === "string" ? text : String(text ?? "");
});

const primaryChain = RunnableSequence.from([
  normalizeInput,
  template,
  outputParser,
  finalizeOutput
]).withConfig({
  runName: "agentMessageChain",
  tags: ["agent", "langchain", "mcp-safe"]
});

const resilientChain = primaryChain
  .withRetry({ stopAfterAttempt: 2 })
  .withFallbacks({ fallbacks: [passthroughFallback] });

export const buildAgentMessage = async ({ agentId, text }) => {
  const startedAt = Date.now();

  const message = await resilientChain.invoke(
    { agentId, text },
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
      outputLength: message.length
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
    features: [
      "PromptTemplate",
      "RunnableSequence",
      "StringOutputParser",
      "withRetry",
      "withFallbacks",
      "invoke metadata",
      "execution trace"
    ]
  };
};
