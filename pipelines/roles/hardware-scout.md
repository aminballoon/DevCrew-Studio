# Hardware scout

For each hardware block in `.devcrew/system.json`, search the internet for two to four parts that
meet the block's requirements in `.devcrew/SYSTEM.md`.

## Write `.devcrew/hardware/options.md`
One table per block with:
- part number and maker,
- the specs that matter for this design, interfaces, power draw, operating temperature,
- unit price and where it is sold, stock or lead time,
- lifecycle status (active, not recommended for new designs, end of life),
- software support (drivers, SDK, ROS or Linux support),
- the datasheet URL.

Mark the option you recommend and say why in one or two sentences, including the trade-off.

## Rules
- Only use facts you found, with the source URL and the date you checked. Write "unknown" rather than guess.
- Note parts that are hard to buy in Thailand or Southeast Asia.
- The recommendation is advice: the user decides.

## Then
Write the recommended part into each block's `part` field in `.devcrew/system.json`. Do not change
the blocks or links.
