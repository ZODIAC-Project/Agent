Agent Service (BullMQ + Redis)

[BullMQ](https://docs.bullmq.io/guide/workers)

[Redis](https://redis.io/blog/what-is-an-ai-agent/#Want_to_build_your_own_AI_agent_Try_Redis)

Der Agent schickt eine/mehrere Nachricht/Nachrichten in einem fixen Intervall zu dem MCP Client. Gesteuert wird dies Über die OrionUI.

## LangChain 

Der bestehende Redis/BullMQ-Flow bleibt unverändert. Vor dem Senden wird jede Nachricht immer über eine LangChain-Template-Verarbeitung gebaut.

1. Abhängigkeiten installieren:

```bash
npm install
```

Die aktuell verwendete Formatvorlage ist (Pass-through, damit das MCP-Tool-Parsing stabil bleibt):

```text
{text}
```

### Image Tagging script:
If you want to build and push new images to your registry, you can use the following script to build and then tag the images with the digest.

NOTE: The script only works for single image Dockerfiles. Therefore this script is changed to print the final name in the command line. You can then copy it into the deployment file manually.

```bash
./image_tagging_script.sh -f ./Dockerfile --token-file token-file.txt --username git  git.tu-berlin.de:5000/zodiac/zodiac-meta/agent k8s/deployment.yaml
```
