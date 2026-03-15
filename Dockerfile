# ── Build stage: compile llama-cpp-python for CPU (AVX2) ─────────────────────
FROM python:3.11-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY requirements.txt .

# Build llama-cpp-python with explicit AVX2/FMA flags for maximum performance on Google Cloud CPUs
ENV CMAKE_ARGS="-DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_AVX=ON -DGGML_NATIVE=OFF -DGGML_BLAS=OFF -DGGML_CUDA=OFF -DGGML_METAL=OFF"
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

# Download model at build time using huggingface-cli
RUN pip install --no-cache-dir huggingface_hub[cli] && \
    mkdir -p /app/models && \
    huggingface-cli download Qwen/Qwen2.5-3B-Instruct-GGUF \
    qwen2.5-3b-instruct-q8_0.gguf \
    --local-dir /app/models --local-dir-use-symlinks False && \
    ls -lh /app/models/

# ── Environment defaults ──────────────────────────────────────────────────────
ENV MODEL_PATH=/app/models/qwen2.5-3b-instruct-q8_0.gguf
ENV N_CTX=2048
ENV N_THREADS=8
ENV MAX_PARALLEL=4
ENV MAX_TOKENS=1024
ENV TEMPERATURE=0.3
ENV REPEAT_PENALTY=1.1
ENV PORT=8000
ENV PYTHONUNBUFFERED=1

EXPOSE 8000

# Use entrypoint.sh so $PORT is expanded by shell before exec
CMD ["/app/entrypoint.sh"]

