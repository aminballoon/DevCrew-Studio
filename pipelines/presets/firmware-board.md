# Preset: Firmware for a custom board (`firmware-board`)

**Use it for:** firmware for a microcontroller board (for example STM32), where the tests must run
on the real hardware.
**Kind:** build (ends in committed code). **Definition:** `pipelines/firmware-board.json`.
**Status:** approved 2026-10-12; a version using role guides is waiting for review in `pipelines/drafts/`.

## What to prepare

- **Source folder** with whatever you have. All optional, but more is better:
  - the CubeMX `.ioc` file (pins, clocks, peripherals),
  - schematic and PCB layout (KiCad, Altium, Eagle, Gerber or PDF), BOM,
  - existing firmware and its build files (Makefile, CMakeLists.txt).
- **Or just the board name** in the requirement (for example "NUCLEO-F446RE"). The board researcher
  looks it up online.
- **The test rig** (for hardware-in-the-loop tests):
  - the board connected through its programmer (ST-Link, J-Link, USB DFU...) to the machine that
    runs DevCrew, or to a test host you can reach with SSH,
  - the flashing tools on that machine (openocd, st-flash, STM32_Programmer_CLI, pyocd or dfu-util),
  - for SSH: a host alias in your `~/.ssh/config` with key login. Never put passwords in the requirement.

### Requirement template

```markdown
# <Firmware feature>

## Board
<Board name or "see the .ioc and schematic in the project folder">

## What the firmware should do
<Behaviour, timings, interfaces.>

## Acceptance
- <Testable on the board, e.g. "prints the temperature on USART2 every 1 s, within 0.5 °C">

## Test rig
- Connection: <local USB | SSH host alias "hil-pi" | USB hub port 3 via uhubctl>
- Programmer: <ST-Link V2-1 on the board>
- Serial port for test output: <ST-Link virtual COM port, 115200 baud>

## Must not change
- <Pins, peripherals or generated code that must stay>
```

## Steps

The Agent column is the default. A profile in `devcrew.config.json` can give any role another
agent by its step id (for example `"scout": "codex"`); see [README](README.md#which-ai-does-each-role).

| # | Step | Agent | Writes / hands on |
|---|---|---|---|
| 1 | **Board researcher** | claude | `.devcrew/hardware/board.md` |
| 2 | **HIL rig engineer** | claude | `.devcrew/hil/` (rig files below) |
| 3 | Planner | profile | spec, architecture, contracts, plan (reads both reports) |
| 4 | **You: Gate 1** "Review the board, the test rig and the plan" | | approve, or send back to the HIL rig engineer (it and the Planner run again with your notes) |
| 5 | QA | profile | `tests/`, including tests that run on the board through the rig |
| 6 | Dev + Verify | profile | the firmware; up to **4 tries per part**, then you decide |
| 7 | **Firmware reviewer** | claude | `.devcrew/firmware-review.md`; can send the code back to Dev **at most 2 times** for high or critical hardware problems |
| 8 | **You: Gate 2** "Approve the merge" | | approve and commit, or send back to Dev |

### Board researcher: `.devcrew/hardware/board.md`

MCU part number, package, flash and RAM; clocks; a pin table (pin, signal, peripheral, direction,
pull, connected part); external parts with their interface and datasheet link; power rails, boot
pins and reset; the programming interface and probe; the serial ports a test can read. Every fact
is marked **from-file**, **from-internet** (with the URL) or **assumed**, followed by the
assumptions you must confirm and any conflicts between the requirement and the board.

### HIL rig engineer: `.devcrew/hil/`

| File | What it does |
|---|---|
| `rig.json` | Board, connection (local, SSH host alias, USB hub port), programmer and target, probe serial, serial port and baud, lock name, timeouts |
| `probe.sh` | Checks the probe and board are reachable and prints the MCU id; fails with a plain message such as "board not connected" |
| `flash.sh <firmware>` | Programs and verifies the firmware |
| `monitor.sh <seconds>` | Resets the board and captures its serial output |
| `run.sh <firmware> <seconds>` | Takes the board's lock, probes, flashes, captures the output, releases the lock |
| `RIG.md` | The setup in plain words, what you must connect or install, and the exact commands tests call |

- **One board, one run at a time:** an exclusive lock per board (flock, named after the probe
  serial, with a timeout).
- **Test protocol:** firmware built in test mode prints `HIL:PASS <name>` or `HIL:FAIL <name> <reason>`
  per check, then `HIL:DONE`. Host tests call `run.sh` and check those lines.
- **Safety:** during its own turn the rig engineer only runs read-only commands (list devices,
  probe, read the MCU id). It never flashes, erases, changes option bytes or read-out protection,
  or power-cycles ports that are not the board's, and never writes passwords or keys.
- `.devcrew/` is read-only for Dev, so Dev cannot change the rig to make tests pass.

### Firmware reviewer

Checks the changes against the board: pins and peripherals, clock and timer settings, interrupt
handlers (short, non-blocking, shared data handled safely), DMA buffers, HAL return codes, timeouts
on every hardware wait, RAM use, the watchdog, test mode disabled in release builds, and CubeMX
code edited only inside `USER CODE` sections.

## Role guides and agent needs

- Guides: [board-researcher](../roles/board-researcher.md), [hil-rig-engineer](../roles/hil-rig-engineer.md), [firmware-reviewer](../roles/firmware-reviewer.md). They hold each role's full instructions.
- **Board researcher** needs `web`; **HIL rig engineer** needs `shell`. A run is refused before it starts if the profile gives a role an agent that cannot do what it needs.

## What you review

- **Gate 1:** the board facts marked *assumed*, the rig (does it match your bench?), and the plan.
- **Gate 2:** the diff, the test results from the board, and the firmware review.

## Limits

- The hardware tests need the board and the tools on the machine running DevCrew or the SSH host.
  If the board is not connected, the tests fail with "board not connected" and the run waits for you.
- A gate sends work back to one step: Gate 1 goes back to the rig engineer, not the board researcher,
  so the online research is not repeated each time.
