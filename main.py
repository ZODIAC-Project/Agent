
import asyncio

from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from contextlib import asynccontextmanager
from pydantic import BaseModel
from uuid import UUID, uuid4
import threading
import requests
import sqlite3
import logging
import time
import json
import sys
import os

MCP_URL = os.getenv("MCP_URL", "http://130.149.158.32:30084/chat")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)

class Agent(BaseModel):
    id: UUID | None = None
    intervalMs: int
    runOnce: bool
    text: str
    purposes: list[str]
    memoryWindow: int

con = sqlite3.connect('agents.db')
c = con.cursor()

# Create the agents table if it doesn't exist
c.execute('''CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    intervalMs INTEGER,
    runOnce INTEGER,
    text TEXT,
    purposes TEXT,
    memoryWindow INTEGER
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
    logging.info(f"Rescheduled {len(rows)} agents on startup")
    yield
    logging.info("Shutting down Agent API...")

app = FastAPI(lifespan=lifespan)

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
    agent_id = str(uuid4())
    con = sqlite3.connect('agents.db')
    c = con.cursor()

    interval_ms = max(1000, agent.intervalMs)  # Ensure minimum interval of 1 second

    # Insert the new agent into the database
    c.execute(
        "INSERT INTO agents (id, intervalMs, runOnce, text, purposes, memoryWindow) VALUES (?, ?, ?, ?, ?, ?)",
        (
            agent_id,
            interval_ms,
            1 if agent.runOnce else 0,
            agent.text,
            json.dumps(agent.purposes),
            agent.memoryWindow,
        )
    )

    con.commit()
    con.close()
    interval_seconds = max(1, interval_ms / 1000)
    threading.Timer(interval_seconds, agent_task, args=[agent_id]).start()

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
        })
    con.close()
    return agents

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
    return {"message": f"Agent with id {agent_id} deleted"}

@app.delete("/agents")
def delete_all_agents():
    con = sqlite3.connect('agents.db')
    c = con.cursor()
    c.execute("DELETE FROM history")
    c.execute("DELETE FROM agents")
    con.commit()
    con.close()
    return {"message": "All agents deleted"}

def agent_task(agent_id):
    # 1. test if agent still exists

    con = sqlite3.connect('agents.db')
    c = con.cursor()
    c.execute("SELECT id, intervalMs, runOnce, text, purposes FROM agents WHERE id = ?", (agent_id,))
    agent = c.fetchone()
    if not agent:
        con.close()
        return
    logging.info(f"Running task for agent {agent_id}")

    # 2. Make the POST request to the MCP with the agent's text and purposes

    data = {
        "message": agent[3],
        "purposes": json.loads(agent[4]),
        "session_id": agent_id
    }

    c.execute("INSERT INTO history (agent_id, timestamp, type, message) VALUES (?, ?, ?, ?)", (agent_id, int(time.time()), "outgoing", agent[3]))
    con.commit()
    
    x = requests.post(MCP_URL, json=data)

    # agent could have been deleted while the request was in-flight, so check again if it still exists before trying to log the response
    c.execute("SELECT id, intervalMs, runOnce, text, purposes FROM agents WHERE id = ?", (agent_id,))
    agent = c.fetchone()
    if not agent:
        con.close()
        return

    res = json.loads(x.text)
    c.execute("INSERT INTO history (agent_id, timestamp, type, message) VALUES (?, ?, ?, ?)", (agent_id, int(time.time()), "incoming", res["response"]))
    con.commit()

    logging.info(f"Agent {agent_id} task response: {x.text}")
    
    # 3. Reschedule the task if it's not a run-once agent

    if agent[2]:  # runOnce is True
        c.execute("DELETE FROM agents WHERE id = ?", (agent_id,))
        c.execute("DELETE FROM history WHERE agent_id = ?", (agent_id,))
        con.commit()
        con.close()
        logging.info(f"Run-once Agent {agent_id} deleted after execution")
    else:
        interval_seconds = max(1, agent[1] / 1000)
        threading.Timer(interval_seconds, agent_task, args=[agent_id]).start()
    con.close()

@app.websocket("/agents")
async def websocket_agents(websocket: WebSocket):
    # live update of all agents for dashboard
    await websocket.accept()
    while True:
        try:
            con = sqlite3.connect('agents.db')
            c = con.cursor()
            c.execute("SELECT id, intervalMs, runOnce, text, purposes, memoryWindow FROM agents")
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