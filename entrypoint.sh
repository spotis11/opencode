#!/bin/sh
# OpenCode Web container entrypoint: start the local model server (Ollama on
# 127.0.0.1:11434), make sure the local models exist (pulled into
# /var/lib/ollama/models — the container's main disk, ~18 GB free; a deploy
# resets the container filesystem, so the first boot after each deploy
# re-pulls them), then hand off to the web shell (server.js), which brings up
# the engine sidecar.
set -e

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

# Pull missing models in the background — the web shell starts right away and
# /__status reports model readiness. Never pull more than the free space on
# the models disk allows: a full disk breaks the engine's SQLite writes
# (SIGBUS), so keeping ~1 GB of headroom matters more than having every model.
#   tag:approx-size-in-KB
MODELS="qwen2.5-coder:1.5b:1050000 llama3.2:3b:2100000 qwen2.5-coder:7b:4900000"

(
  have="$(ollama ls 2>/dev/null | awk '{print $1}')"
  for entry in $MODELS; do
    m="${entry%%:*}"
    rest="${entry#*:}"
    need_kb="${rest##*:}"
    case " $have " in
      *" $m "*) continue ;;
    esac
    free_kb="$(df -Pk /var/lib/ollama 2>/dev/null | awk 'NR==2 {print $4}')"
    if [ "${free_kb:-0}" -lt "$((need_kb + 1048576))" ]; then
      echo "[entrypoint] skip $m — only ${free_kb}KB free on the models disk (need ~${need_kb}KB + headroom)"
      continue
    fi
    if ollama pull "$m" >"/tmp/ollama-pull.log" 2>&1; then
      echo "[entrypoint] pulled $m"
    else
      echo "[entrypoint] WARNING: pull $m failed (see /tmp/ollama-pull.log)"
    fi
  done
) &

exec node /app/server.js
