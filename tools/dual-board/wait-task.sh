#!/usr/bin/env bash
# Compatibility entry: implementation remains in the packaged tools/wait-task.sh.
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/wait-task.sh" "$@"
