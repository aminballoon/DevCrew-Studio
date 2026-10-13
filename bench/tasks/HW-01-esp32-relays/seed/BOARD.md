# Waveshare ESP32-S3-ETH-8DI-8RO — pin table (vendor wiki)

| Function | Part | ESP32-S3 pins / address |
|---|---|---|
| I2C bus | — | SDA GPIO42, SCL GPIO41 |
| Relay outputs 1–8 | TCA9554 I/O expander | I2C `0x20` |
| Real-time clock | PCF85063 | I2C `0x51` |
| Ethernet | W5500 (SPI) | SCLK GPIO15, MISO GPIO14, MOSI GPIO13, CS GPIO16 |
| Digital inputs DI1–DI8 | Opto-isolated | GPIO4–GPIO11 |
| USB | ESP32-S3 USB Serial/JTAG | GPIO19/20 |
