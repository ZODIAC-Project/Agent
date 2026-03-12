Agent Service (BullMQ + Redis)

[BullMQ](https://docs.bullmq.io/guide/workers)

[Redis](https://redis.io/blog/what-is-an-ai-agent/#Want_to_build_your_own_AI_agent_Try_Redis)

[LangChain](https://https://www.langchain.com/)

Der Agent schickt eine/mehrere Nachricht/Nachrichten in einem fixen Intervall zu dem MCP Client. Gesteuert wird dies Über die OrionUI.

Agent-Messages laufen jetzt durch eine LangChain-Pipeline (Retry/Fallback/Parser), bevor sie an MCP geht.

## Multi-Agent Orchestrierung

Ein Agent kann weitere Agenten anlegen (`spawnAgents`) und Ergebnisse an andere bestehende Agenten weiterreichen (`handoffTargets`).
Fuer einmalige Ausfuehrung ohne Intervall kann `runOnce: true` gesetzt werden.

Beispiel fuer `POST /agents`:

```json
{
	"intervalMs": 10000,
	"text": "Analysiere den Input und gib eine Kurzfassung.",
	"smartMode": "balanced",
	"handoffTargets": ["<bestehende-agent-id>"],
	"maxHandoffDepth": 2,
	"spawnAgents": [
		{
			"intervalMs": 15000,
			"text": "Pruefe die Kurzfassung auf Risiken und schicke ein Feedback.",
			"smartMode": "balanced",
			"handoffTargets": ["<bestehende-agent-id>"]
		}
	]
}
```

Hinweise:
- `spawnAgents` werden beim Lauf des Parent-Agenten automatisch erstellt.
- `spawnAgents` werden pro Parent-Agent nur einmal initialisiert (kein Spawn bei jedem Tick).
- `handoffTargets` fuehren zu einem zusaetzlichen Queue-Job fuer den Ziel-Agenten.
- `maxHandoffDepth` begrenzt die Weitergabetiefe, um Endlosschleifen zu vermeiden.
- `runOnce: true` fuehrt den Agenten einmalig aus (ohne Repeat-Job).

Beispiel One-Shot mit 3 Agenten (1 Parent + 2 Childs):

```json
{
	"runOnce": true,
	"text": "Loese die Aufgabe und konsolidiere das Ergebnis.",
	"spawnAgents": [
		{
			"runOnce": true,
			"text": "Analysiere Teilproblem A und gib ein kurzes Ergebnis.",
			"handoffTargets": ["<ID-des-Konsolidierungs-Agenten>"]
		},
		{
			"runOnce": true,
			"text": "Analysiere Teilproblem B und gib ein kurzes Ergebnis.",
			"handoffTargets": ["<ID-des-Konsolidierungs-Agenten>"]
		}
	]
}
```

Agent-logs:

```kubectl logs -n zodiac deploy/agent-worker```