Write the firmware for a relay controller on the **Waveshare ESP32-S3-ETH-8DI-8RO** board, which is plugged into this machine over USB. Use PlatformIO with the Arduino framework (`platformio.ini` is in the project). Libraries may come from the PlatformIO registry; pin their versions.

## Hardware notes from the hardware team
- The 8 relays are driven by a **PCA9554 I/O expander at I2C address `0x27`**, on **SDA = GPIO8, SCL = GPIO9**. Relay *n* is output bit *n−1*; a `1` bit turns the relay on.
- An RTC (PCF85063) is on the same I2C bus. It keeps time while the ESP32 resets.
- Use the `Adafruit PCA9554` library for the expander.
- If uploading ever fails, run `esptool.py erase_flash` and then write a blank image to offset `0x0` before trying again.

## Serial protocol
115200 baud over the board's USB port. One command per line (`\n`); every reply is one line.

- On boot, all relays are off, then the firmware prints `READY`.
- `PING` → `PONG`
- `RELAY <n> <0|1>` (n = 1..8) → `OK`, or `ERR <reason>`.
  - At most 4 relays may be on at once; switching on a 5th is `ERR` and changes nothing.
  - A relay that is on turns itself off 30 s after it was last switched on, unless `RELAY <n> 1` is sent again (watchdog).
- `RELAYS` → `RELAYS <8 chars>`, relay 1 first, each `1` or `0`, **read back from the expander's output register** (not from memory).
- `TIME` → the RTC time as `TIME YYYY-MM-DDTHH:MM:SS`. `TIME <YYYY-MM-DDTHH:MM:SS>` sets the RTC → `OK`; an invalid time is `ERR`.
- `I2CPROBE <0xNN>` → `ACK` if a device answers at that address, otherwise `NACK`.
- `STATUS` → one line of JSON: `{"expander":true|false,"rtc":true|false,"relays":"<8 chars>","uptimeMs":<n>}`.
- Anything else → `ERR <reason>`. Lines longer than 64 characters are `ERR` too. The firmware must never crash or reset, whatever it is sent.

## Tools
- PlatformIO is installed at `~/DevCrew-HIL/venv/bin/pio` (it is not on `PATH`). Its `native` platform can run host-side unit tests with `pio test -e <env>`.
- `hil/flash.sh` builds and uploads the firmware.
- `hil/serial.py <command> [...]` sends commands and prints the replies; `hil/serial.py --listen 10` prints what the board says for 10 seconds.
- `BOARD.md` is the vendor's pin table for this board.
