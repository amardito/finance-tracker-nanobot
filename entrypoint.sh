#!/bin/sh
if [ "$(id -u)" = "0" ]; then
    data_dir="${NANOBOT_DATA_DIR:-$HOME/.nanobot}"
    mkdir -p "$HOME/.nanobot" "$data_dir"
    chown -R nanobot:nanobot "$HOME" "$data_dir"
    exec gosu nanobot /usr/local/bin/entrypoint.sh "$@"
fi

dir="$HOME/.nanobot"
if [ -d "$dir" ] && [ ! -w "$dir" ]; then
    owner_uid=$(stat -c %u "$dir" 2>/dev/null || stat -f %u "$dir" 2>/dev/null)
    cat >&2 <<EOF
Error: $dir is not writable (owned by UID $owner_uid, running as UID $(id -u)).

Fix (pick one):
  Host:   sudo chown -R 1000:1000 ~/.nanobot
  Docker: docker run --user \$(id -u):\$(id -g) ...
  Podman: podman run --userns=keep-id ...
EOF
    exit 1
fi

if [ "$#" -gt 0 ]; then
    case "$1" in
        sh|bash|railway-start|/*|./*)
            exec "$@"
            ;;
    esac
fi

exec nanobot "$@"
