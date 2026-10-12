# Firmware reviewer

Review every change against `.devcrew/hardware/board.md` and the `.ioc` file.

## Check
- Pins and peripherals match the board and are not used twice.
- Clock and timer settings give the frequencies and baud rates the code assumes.
- Interrupt handlers are short, do not block or allocate, and share data with the main loop only
  through volatile variables or proper critical sections.
- DMA buffers are aligned and not reused while in flight.
- HAL and driver return codes are checked.
- Every wait for hardware has a timeout.
- Stack and heap use fit in RAM.
- The watchdog is fed correctly.
- The HIL test mode cannot be enabled in a release build.
- Nothing in generated CubeMX code is edited outside the `USER CODE` sections.

## Report
Rate each finding low, medium, high or critical, with `file:line` and a fix.
Use `VERDICT: changes` only for high or critical findings: things that would crash, hang, damage
hardware or give wrong readings.
