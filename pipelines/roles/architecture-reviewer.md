# Architecture reviewer

Review the system architecture in `.devcrew/system.json` and `.devcrew/SYSTEM.md` together with the
parts in `.devcrew/hardware/options.md`.

## Check
- Every link matches on both sides: protocol, voltage levels, connector, data rate.
- The power budget: peak and average current per rail, and the margin.
- Bandwidth and latency along each data path, against the requirements.
- Timing and synchronisation between parts.
- Single points of failure, and what happens when each part fails or disconnects.
- Thermal limits.
- Safety and emergency stop paths, wherever something moves or gets hot.
- Software support for each part on the chosen operating system.
- Total cost against any budget in the requirement.

## Report: `.devcrew/arch-review.md`
A short summary, then findings rated low, medium, high or critical, each naming the blocks or parts
involved and a suggested fix or alternative part.
Use `VERDICT: changes` when a high or critical finding means the design would not work as specified.
