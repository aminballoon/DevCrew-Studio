#!/bin/sh
# Builds and uploads the firmware to the board. Waits if another job is using the board.
cd "$(dirname "$0")/.." || exit 1
PORT=$(ls /dev/cu.usbmodem* 2>/dev/null | head -1)
[ -n "$PORT" ] || { echo "board not found on USB"; exit 1; }
echo "$(date -u +%FT%TZ) $(pwd)" >> "$HOME/DevCrew-HIL/logs/flash.log"
exec "$HOME/DevCrew-HIL/bin/hil-locked" "$HOME/DevCrew-HIL/venv/bin/pio" run -t upload --upload-port "$PORT"
