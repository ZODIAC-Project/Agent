Agent Service (BullMQ + Redis)

[BullMQ](https://docs.bullmq.io/guide/workers)

[Redis](https://redis.io/blog/what-is-an-ai-agent/#Want_to_build_your_own_AI_agent_Try_Redis)

[LangChain](https://https://www.langchain.com/)

Der Agent schickt eine/mehrere Nachricht/Nachrichten in einem fixen Intervall zu dem MCP Client. Gesteuert wird dies Über die OrionUI.

Agent-Messages laufen jetzt durch eine LangChain-Pipeline (Retry/Fallback/Parser), bevor sie an MCP geht.

Agent-logs:

```kubectl logs -n zodiac deploy/agent-worker```