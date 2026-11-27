#!/bin/sh
# OpenCode Web container entrypoint: start the local model server (Ollama,
# serving the models baked into this image on 127.0.0.1:11434), then hand off
# to the web shell (server.js), which brings up the engine sidecar.
set -e

ollama serve >/tmp/ollama.log 2>&1 &
i=0
while [ "$i" -lt 120 ] && ! curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; do
  sleep 0.5
  i=$((i + 1))
done
if [ "$i" -lt 120 ]; then
  echo "[entrypoint] ollama ready — models: $(ollama ls 2>/dev/null | tail -n +2 | awk '{print $1}' | tr '\n' ' ')"
else
  echo "[entrypoint] WARNING: ollama did not become ready in 60s; continuing (see /tmp/ollama.log)"
fi

exec node /app/server.js
