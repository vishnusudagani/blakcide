FROM python:3.12-slim

WORKDIR /app

# Build deps for any native wheels (onnxruntime for turn-detection, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY agent.py .

# Pre-download model assets (VAD / turn detector) so cold starts are fast.
RUN python agent.py download-files || true

# Cloud Run: the worker connects OUT to LiveKit and waits for jobs; the health
# server (in agent.py) binds $PORT so the container passes Cloud Run's check.
CMD ["python", "agent.py", "start"]
