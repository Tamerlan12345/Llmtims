# ── Build stage: compile llama-cpp-python for CPU (AVX2) ─────────────────────
FROM python:3.11-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY requirements.txt .

# Build llama-cpp-python without GPU — enables AVX2 for best CPU throughput
ENV CMAKE_ARGS="-DGGML_BLAS=OFF -DGGML_CUDA=OFF -DGGML_METAL=OFF"
ENV FORCE_CMAKE=1

RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt


# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

# Install only runtime libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /usr/local/lib/python3.11 /usr/local/lib/python3.11
COPY --from=builder /usr/local/bin /usr/local/bin

# Copy app files
COPY main.py index.html ./

# Download model at build time (saves cold-start time on Railway)
# Alternatively, mount a volume and set MODEL_PATH env var
RUN python - <<'EOF'
import os
from huggingface_hub import hf_hub_download

os.makedirs("/app/models", exist_ok=True)
print("Downloading gemma-2-2b-it-Q4_K_M.gguf …")
path = hf_hub_download(
    repo_id="bartowski/gemma-2-2b-it-GGUF",
    filename="gemma-2-2b-it-Q4_K_M.gguf",
    local_dir="/app/models",
    local_dir_use_symlinks=False,
)
print(f"Saved to {path}")
EOF

# ── Environment defaults ──────────────────────────────────────────────────────
ENV MODEL_PATH=/app/models/gemma-2-2b-it-Q4_K_M.gguf
ENV N_CTX=2048
# Railway gives 4–8 vCPU depending on plan
ENV N_THREADS=4
ENV MAX_PARALLEL=4
ENV MAX_TOKENS=512
ENV TEMPERATURE=0.7
ENV REPEAT_PENALTY=1.1
ENV PORT=8000

EXPOSE 8000

# Uvicorn: 1 worker (model is not fork-safe), loop=asyncio
CMD uvicorn main:app \
    --host 0.0.0.0 \
    --port $PORT \
    --workers 1 \
    --loop asyncio \
    --timeout-keep-alive 120
