# ── Build stage: compile llama-cpp-python for CPU (AVX2) ─────────────────────
FROM python:3.11-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git curl libopenblas-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY requirements.txt .

# Build llama-cpp-python with OpenBLAS for significant CPU speedup
ENV CMAKE_ARGS="-DGGML_BLAS=ON -DGGML_CUDA=OFF -DGGML_METAL=OFF"
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
COPY main.py index.html entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Download model at build time (saves cold-start time on Railway)
# Alternatively, mount a volume and set MODEL_PATH env var
RUN python - <<'EOF'
import os
from huggingface_hub import hf_hub_download

os.makedirs("/app/models", exist_ok=True)
print("Downloading Qwen2.5-1.5B-Instruct-Q3_K_M.gguf …")
path = hf_hub_download(
    repo_id="bartowski/Qwen2.5-1.5B-Instruct-GGUF",
    filename="Qwen2.5-1.5B-Instruct-Q3_K_M.gguf",
    local_dir="/app/models",
    local_dir_use_symlinks=False,
)
print(f"Saved to {path}")
EOF

# ── Environment defaults ──────────────────────────────────────────────────────
ENV MODEL_PATH=/app/models/Qwen2.5-1.5B-Instruct-Q3_K_M.gguf
ENV N_CTX=2048
ENV N_THREADS=4
ENV MAX_PARALLEL=4
ENV MAX_TOKENS=1024
ENV TEMPERATURE=0.3
ENV REPEAT_PENALTY=1.1
ENV PORT=8000
ENV PYTHONUNBUFFERED=1

EXPOSE 8000

# Use entrypoint.sh so $PORT is expanded by shell before exec
CMD ["/app/entrypoint.sh"]

