import { PromptTemplate } from "@langchain/core/prompts";

const promptTemplate = "{text}";

const template = PromptTemplate.fromTemplate(promptTemplate);

export const buildAgentMessage = async ({ agentId, text }) => {
  return template.format({
    agentId,
    text
  });
};
