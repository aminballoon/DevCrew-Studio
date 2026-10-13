#!/bin/sh
# google-antigravity-acp starts agy with --print-timeout=60m and has no option to change it, which cut
# single-agent runs at 60 min. DevCrew enforces its own turn and task limits, so let agy wait (0).
for a in "$@"; do
  case "$a" in --print-timeout=*) set -- "$@" "--print-timeout=0" ;; *) set -- "$@" "$a" ;; esac
  shift
done
exec "${AGY_BIN:-$HOME/.local/bin/agy}" "$@"
