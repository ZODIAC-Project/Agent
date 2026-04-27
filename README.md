# Rewrite of the Agent Management API

**endpoints:**  
`GET /health` - returns `status: ok`  
`GET /agents` - list of all active agents  
`POST /agents` - create a new agent with the passed arguments  
`DELETE /agents` - delete all agents  
`DELETE /agents/{agent-id}` - delete the agent with the id `{agent-id}`

**run locally:**  
`uv run python -m uvicorn main:app --host 0.0.0.0 --port 30086`

**example requests:** (replace the ip with the correct target ip)

create a new agent
```
curl -X POST "http://127.0.0.1:8000/agents" -H "Content-Type: application/json" -d '{
    "intervalMs": 5000,
    "runOnce": true,
    "text": "what is your favourite color?",
    "purposes": ["cleanup-test"],
    "memoryWindow": 1
}'
```

get all agents
```
curl "http://127.0.0.1:8000/agents"
```