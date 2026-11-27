#!/bin/sh
# OpenCode Web container entrypoint: start the local model server (Ollama on
# 127.0.0.1:11434), make sure the local models exist (they are pulled into
# the persistent /data volume on first boot and after every deploy, since a
# deploy resets the container filesystem), then hand off to the web shell
# (server.js), which brings up the engine sidecar.
set -e

WANT="qwen2.5-coder:1.5b llama3.2:3b qwen2.5-coder:7b"

ollama serve >/tmp/ollama.log 2>&1 &
i=0
while [ "$i" -lt 120 ] && ! curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; do
  sleep 0.5
  i=$((i + 1))
done
if [ "$i" -lt 120 ]; then
  echo "[entrypoint] ollama ready"
else
  echo "[entrypoint] WARNING: ollama did not become ready in 60s; continuing (see /tmp/ollama.log)"
fi

# Pull any missing models in the background — the web shell starts right away
# and /__status reports model readiness; a request for a model that is still
# downloading simply has to wait for the pull to land.
have="$(ollama ls 2>/dev/null | awk '{print $1}')"
missing=""
for m in $WANT; do
  case " $have " in
    *" $m "*) ;;
    *) missing="$missing $m" ;;
  esac
done
if [ -n "$missing" ]; then
  echo "[entrypoint] pulling local models:$missing (background)"
  (
    for m in $missing; do
      ollama pull "$m" >/tmp/ollama-pull.log 2>&1 \
        && echo "[entrypoint] pulled $m" \
        || echo "[entrypoint] WARNING: pull $m failed (see /tmp/ollama-pull.log)"
    done
  ) &
fi

exec node /app/server.js
