import asyncio
import json
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ── Config ────────────────────────────────────────────────────────────────────

MODEL_PATH   = os.getenv(“MODEL_PATH”, “./models/gemma-2-2b-it-Q4_K_M.gguf”)
N_CTX        = int(os.getenv(“N_CTX”,    “2048”))
N_THREADS    = int(os.getenv(“N_THREADS”, str(os.cpu_count() or 4)))
MAX_PARALLEL = int(os.getenv(“MAX_PARALLEL”, “4”))   # active generation slots
MAX_TOKENS   = int(os.getenv(“MAX_TOKENS”,  “512”))
TEMPERATURE  = float(os.getenv(“TEMPERATURE”, “0.7”))
REPEAT_PEN   = float(os.getenv(“REPEAT_PENALTY”, “1.1”))

# ── Global state ──────────────────────────────────────────────────────────────

llm          = None
semaphore    = None   # limits parallel inference to MAX_PARALLEL
queue_stats  = {“waiting”: 0, “active”: 0}

# ── Lifespan: load model once ─────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
global llm, semaphore
print(f”[boot] Loading model from {MODEL_PATH} …”)
print(f”[boot] n_ctx={N_CTX}  threads={N_THREADS}  max_parallel={MAX_PARALLEL}”)

```
from llama_cpp import Llama
llm = Llama(
    model_path=MODEL_PATH,
    n_ctx=N_CTX,
    n_threads=N_THREADS,
    n_gpu_layers=0,          # CPU-only
    verbose=False,
    chat_format="gemma",     # built-in Gemma chat template
)
semaphore = asyncio.Semaphore(MAX_PARALLEL)
print("[boot] Model ready ✓")
yield
print("[boot] Shutting down …")
```

app = FastAPI(lifespan=lifespan)

# ── Schemas ───────────────────────────────────────────────────────────────────

class Message(BaseModel):
role: str    # “user” | “assistant” | “system”
content: str

class ChatRequest(BaseModel):
messages: list[Message]
session_id: str = “”

# ── SSE helper ────────────────────────────────────────────────────────────────

def sse(data: dict) -> str:
return f”data: {json.dumps(data, ensure_ascii=False)}\n\n”

# ── Core streaming generator ──────────────────────────────────────────────────

async def stream_response(messages: list[Message]) -> AsyncGenerator[str, None]:
global queue_stats

```
# Tell client they are queued
queue_stats["waiting"] += 1
yield sse({"type": "queue", "waiting": queue_stats["waiting"]})

async with semaphore:
    queue_stats["waiting"] = max(0, queue_stats["waiting"] - 1)
    queue_stats["active"] += 1
    yield sse({"type": "start"})

    try:
        loop = asyncio.get_event_loop()
        msgs = [{"role": m.role, "content": m.content} for m in messages]

        # Run blocking llama-cpp in thread pool so event-loop stays free
        def _generate():
            return llm.create_chat_completion(
                messages=msgs,
                max_tokens=MAX_TOKENS,
                temperature=TEMPERATURE,
                repeat_penalty=REPEAT_PEN,
                stream=True,
            )

        stream = await loop.run_in_executor(None, _generate)

        full_text = ""
        for chunk in stream:
            delta = chunk["choices"][0]["delta"]
            token = delta.get("content", "")
            if token:
                full_text += token
                yield sse({"type": "token", "text": token})
                await asyncio.sleep(0)   # yield control back to event loop

        yield sse({"type": "done", "full": full_text})

    except Exception as e:
        yield sse({"type": "error", "message": str(e)})
    finally:
        queue_stats["active"] = max(0, queue_stats["active"] - 1)
```

# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.post(”/chat/stream”)
async def chat_stream(req: ChatRequest):
return StreamingResponse(
stream_response(req.messages),
media_type=“text/event-stream”,
headers={
“Cache-Control”:   “no-cache”,
“X-Accel-Buffering”: “no”,
“Connection”:      “keep-alive”,
},
)

@app.get(”/status”)
async def status():
return {
“model”:    os.path.basename(MODEL_PATH),
“active”:   queue_stats[“active”],
“waiting”:  queue_stats[“waiting”],
“slots”:    MAX_PARALLEL,
}

# ── Frontend ──────────────────────────────────────────────────────────────────

@app.get(”/”, response_class=HTMLResponse)
async def index():
with open(“index.html”, encoding=“utf-8”) as f:
return f.read()
