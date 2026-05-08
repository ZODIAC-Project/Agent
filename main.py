# web server
from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from prometheus_client import Counter, Gauge, Histogram, make_asgi_app
from contextlib import asynccontextmanager
from pydantic import BaseModel
# other
from uuid import UUID, uuid4
import threading
import requests
import sqlite3
import logging
import asyncio
import time
import json
import os

MCP_URL = os.getenv("MCP_URL", "http://130.149.158.32:30084/chat")

agent_create_total = Counter(
    "agent_create_total",
    "Total number of agents created"
)

agent_active_count = Gauge(
    "agent_active_count",
    "Current number of active agents"
)

agent_jobs_total = Counter(
    "agent_jobs_total",
    "Total number of agent jobs executed",
    labelnames=["status"]
)

agent_job_duration = Histogram(
    "agent_job_duration_ms",
    "Duration of agent jobs in milliseconds",
    buckets=(10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, float("inf"))
)

agent_mcp_request_duration = Histogram(
    "agent_mcp_request_duration_ms",
    "Duration of MCP requests in milliseconds",
    buckets=(10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, float("inf"))
)

class Agent(BaseModel):
    id: UUID | None = None
    intervalMs: int | None = None
    runOnce: bool
    text: str
    purposes: list[str]
    memoryWindow: int
    paused: bool = False
    listenTopic: str | None = None

con = sqlite3.connect('agents.db')
c = con.cursor()

# Create the agents table if it doesn't exist
c.execute('''CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    intervalMs INTEGER,
    runOnce INTEGER,
    text TEXT,
    purposes TEXT,
    memoryWindow INTEGER,
    paused INTEGER,
    listenTopic TEXT
)''')
con.commit()

c.execute('''CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT,
    timestamp INTEGER,
    type TEXT,
    message TEXT,
    FOREIGN KEY (agent_id) REFERENCES agents (id)
)''')
con.commit()

con.close()


def update_agent_active_count():
    con = sqlite3.connect('agents.db')
    c = con.cursor()
    c.execute("SELECT COUNT(*) FROM agents")
    count = c.fetchone()[0]
    con.close()
    agent_active_count.set(count)

@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.info("Starting up Agent API...")
    con = sqlite3.connect('agents.db')
    c = con.cursor()
    c.execute("SELECT id, intervalMs, runOnce FROM agents")
    rows = c.fetchall()
    for row in rows:
        agent_id, interval_ms, run_once = row
        interval_seconds = max(1, interval_ms / 1000)
        threading.Timer(interval_seconds, agent_task, args=[agent_id]).start()
    con.close()
    update_agent_active_count()
    logging.info(f"Rescheduled {len(rows)} agents on startup")
    yield
    logging.info("Shutting down Agent API...")

app = FastAPI(lifespan=lifespan)
app.mount("/metrics", make_asgi_app())

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],        # Allow all domains
    allow_credentials=True,
    allow_methods=["*"],        # Allow all HTTP methods
    allow_headers=["*"],        # Allow all headers
)

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/agents")
def create_agent(agent: Agent):
    if not agent.listenTopic and not agent.intervalMs:
        raise HTTPException(status_code=400, detail="Either intervalMs or listenTopic must be set")
    
    agent_id = str(uuid4())
    con = sqlite3.connect('agents.db')
    c = con.cursor()

    listen_topic = None
    interval_ms = None
    if agent.listenTopic: # event-based agent
        listen_topic = agent.listenTopic
    else: # timed agent
        interval_ms = max(1000, agent.intervalMs)  # Ensure minimum interval of 1 second

    # Insert the new agent into the database
    c.execute(
        "INSERT INTO agents (id, intervalMs, runOnce, text, purposes, memoryWindow, paused, listenTopic) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            agent_id,
            interval_ms,
            1 if agent.runOnce else 0,
            agent.text,
            json.dumps(agent.purposes),
            agent.memoryWindow,
            1 if agent.paused else 0,
            listen_topic
        )
    )

    con.commit()
    con.close()

    if not agent.listenTopic:
        threading.Timer(0, agent_task, args=[agent_id]).start()
    agent_create_total.add(1)
    update_agent_active_count()
    return {"id": agent_id}

@app.get("/agents")
def get_agents():
    con = sqlite3.connect('agents.db')
    c = con.cursor()
    c.execute("SELECT * FROM agents")
    rows = c.fetchall()
    agents = []
    for row in rows:
        agents.append({
            "id": row[0],
            "intervalMs": row[1],
            "runOnce": bool(row[2]),
            "text": row[3],
            "purposes": json.loads(row[4]),
            "memoryWindow": row[5],
            "paused": bool(row[6]),
            "listenTopic": row[7]
        })
    con.close()
    return agents

@app.post("/agents/{agent_id}")
def modify_agent(agent_id: str, options: dict):
    con = sqlite3.connect('agents.db')
    c = con.cursor()
    c.execute("SELECT id, intervalMs, runOnce, text, purposes, paused, listenTopic FROM agents WHERE id = ?", (agent_id,))
    agent = c.fetchone()
    if not agent:
        con.close()
        raise HTTPException(status_code=404, detail=f"Agent with id {agent_id} not found")
    if "pause" in options and options["pause"]:
        c.execute("UPDATE agents SET paused = 1 WHERE id = ?", (agent_id,))
    if "pause" in options and not options["pause"]:
        c.execute("UPDATE agents SET paused = 0 WHERE id = ?", (agent_id,))
    if "datapoint" in options:
        if agent[5]: # paused is True
            logging.info(f"Event-Agent {agent_id} is paused, skipping execution")
        if not send_msg(agent_id, agent, c, con, pretext=f"New MQTT-Message for topic {agent[6]}: {options['datapoint']} "):
            con.close()

    con.commit()
    con.close()
    return {"message": f"Agent with id {agent_id} updated"}


@app.get("/agents/{agent_id}/history")
def get_agent_history(agent_id: str):
    con = sqlite3.connect('agents.db')
    c = con.cursor()
    c.execute(f"SELECT * FROM history WHERE agent_id = ?", (agent_id,))
    rows = c.fetchall()
    history = []
    for row in rows:
        history.append({
            "id": row[0],
            "timestamp": row[2],
            "type": row[3],
            "message": row[4]
        })
    con.close()
    return history

@app.delete("/agents/{agent_id}")
def delete_agent(agent_id: str):
    con = sqlite3.connect('agents.db')
    c = con.cursor()
    # check if agent exists
    c.execute("SELECT * FROM agents WHERE id = ?", (agent_id,))
    agent = c.fetchone()
    if not agent:
        con.close()
        raise HTTPException(status_code=404, detail=f"Agent with id {agent_id} not found")
    c.execute("DELETE FROM agents WHERE id = ?", (agent_id,))
    c.execute("DELETE FROM history WHERE agent_id = ?", (agent_id,))
    con.commit()
    con.close()
    update_agent_active_count()
    return {"message": f"Agent with id {agent_id} deleted"}

@app.delete("/agents")
def delete_all_agents():
    con = sqlite3.connect('agents.db')
    c = con.cursor()
    c.execute("DELETE FROM history")
    c.execute("DELETE FROM agents")
    con.commit()
    con.close()
    update_agent_active_count()
    return {"message": "All agents deleted"}

def agent_task(agent_id):
    task_start_time = time.time()
    # 1. test if agent still exists

    con = sqlite3.connect('agents.db')
    c = con.cursor()
    c.execute("SELECT id, intervalMs, runOnce, text, purposes, paused, listenTopic FROM agents WHERE id = ?", (agent_id,))
    agent = c.fetchone()
    if not agent:
        con.close()
        return
    logging.info(f"Running task for agent {agent_id}")

    if agent[5]:  # paused is True
        logging.info(f"Agent {agent_id} is paused, skipping execution")
        agent_jobs_total.labels(status="paused").inc()
        interval_seconds = max(1, agent[1] / 1000)
        threading.Timer(interval_seconds, agent_task, args=[agent_id]).start()
        con.close()
        return

    # 2. Make the POST request to the MCP with the agent's text and purposes

    if not send_msg(agent_id, agent, c, con):
        agent_jobs_total.labels(status="failed").inc()
        agent_job_duration.observe((time.time() - task_start_time) * 1000)
        con.close()
        return
    
    # 3. Reschedule the task if it's not a run-once agent

    agent_jobs_total.labels(status="success").inc()
    agent_job_duration.observe((time.time() - task_start_time) * 1000)

    if agent[2]:  # runOnce is True
        c.execute("DELETE FROM agents WHERE id = ?", (agent_id,))
        c.execute("DELETE FROM history WHERE agent_id = ?", (agent_id,))
        con.commit()
        con.close()
        update_agent_active_count()
        logging.info(f"Run-once Agent {agent_id} deleted after execution")
    else:
        interval_seconds = max(1, agent[1] / 1000)
        threading.Timer(interval_seconds, agent_task, args=[agent_id]).start()
    con.close()

def send_msg(agent_id, agent, c, con, pretext=""):
    data = {
        "message": pretext + agent[3],
        "purposes": json.loads(agent[4]),
        "session_id": agent_id
    }

    c.execute("INSERT INTO history (agent_id, timestamp, type, message) VALUES (?, ?, ?, ?)", (agent_id, int(time.time()), "outgoing", pretext + agent[3]))
    con.commit()
    
    start_time = time.time()
    try:
        x = requests.post(MCP_URL, json=data)
        x.raise_for_status()
    except requests.RequestException as exc:
        logging.exception(f"Agent {agent_id} MCP request failed: {exc}")
        return False
    duration_ms = (time.time() - start_time) * 1000

    agent_mcp_request_duration.observe(duration_ms)
    # agent could have been deleted while the request was in-flight, so check again if it still exists before trying to log the response
    c.execute("SELECT id, intervalMs, runOnce, text, purposes, listenTopic FROM agents WHERE id = ?", (agent_id,))
    agent = c.fetchone()
    if not agent:
        return False

    res = x.json()
    c.execute("INSERT INTO history (agent_id, timestamp, type, message) VALUES (?, ?, ?, ?)", (agent_id, int(time.time()), "incoming", res["response"]))
    con.commit()

    logging.info(f"Agent {agent_id} task response: {x.text}")
    return True

@app.websocket("/agents")
async def websocket_agents(websocket: WebSocket):
    # live update of all agents for dashboard
    await websocket.accept()
    while True:
        try:
            con = sqlite3.connect('agents.db')
            c = con.cursor()
            c.execute("SELECT id, intervalMs, runOnce, text, purposes, memoryWindow, paused, listenTopic FROM agents")
            rows = c.fetchall()
            agents = []
            for row in rows:
                agents.append({
                    "id": row[0],
                    "intervalMs": row[1],
                    "runOnce": bool(row[2]),
                    "text": row[3],
                    "purposes": json.loads(row[4]),
                    "memoryWindow": row[5],
                    "paused": bool(row[6]),
                    "listenTopic": row[7]
                })
            await websocket.send_text(json.dumps(agents))
            con.close()
            await asyncio.sleep(1) # send updates every second
        except Exception as e:
            logging.error(f"Websocket error: {e}")
            break

@app.websocket("/agents/{agent_id}/history")
async def websocket_agent_history(websocket: WebSocket, agent_id: str):
    await websocket.accept()
    while True:
        try:
            con = sqlite3.connect('agents.db')
            c = con.cursor()
            c.execute("SELECT agent_id, timestamp, type, message FROM history WHERE agent_id = ? ORDER BY id DESC LIMIT 50", (agent_id,))
            rows = c.fetchall()
            entries = []
            for row in rows:
                entries.append({
                    "timestamp": row[1],
                    "type": row[2],
                    "message": row[3]
                })
            entries = entries[::-1]
            await websocket.send_text(json.dumps(entries))
            con.close()
            await asyncio.sleep(1) # send updates every second
        except Exception as e:
            logging.error(f"Websocket error: {e}")
            break
