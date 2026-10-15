// Scripted run of the system-integration design pipeline for the fake agent: an architect draws
// the system, a scout finds parts, a reviewer checks it, and your feedback brings a second version.

const SYSTEM_V1 = JSON.stringify({
  title: 'Delivery robot (demo)',
  groups: [{ id: 'brain', name: 'High level' }, { id: 'base', name: 'Mobile base' }],
  blocks: [
    { id: 'battery', name: 'Battery pack', kind: 'power', group: 'base', part: '', description: '24 V pack for motors and electronics' },
    { id: 'lidar', name: '2D LiDAR', kind: 'sensor', group: 'brain', part: '', description: '360 degree scan for mapping and obstacles' },
    { id: 'camera', name: 'Depth camera', kind: 'sensor', group: 'brain', part: '', description: 'Detects people and doors' },
    { id: 'computer', name: 'Main computer', kind: 'compute', group: 'brain', part: '', description: 'Runs ROS 2 navigation' },
    { id: 'mcu', name: 'Motor controller', kind: 'controller', group: 'base', part: '', description: 'Closed-loop wheel speed control and e-stop' },
    { id: 'motors', name: 'Wheel motors', kind: 'actuator', group: 'base', part: '', description: 'Two hub motors with encoders' },
    { id: 'fleet', name: 'Fleet server', kind: 'external', description: 'Sends delivery jobs' },
  ],
  links: [
    { from: 'battery', to: 'computer', interface: '12 V DC-DC', kind: 'power' },
    { from: 'battery', to: 'motors', interface: '24 V', kind: 'power' },
    { from: 'lidar', to: 'computer', interface: 'Ethernet', kind: 'data', label: 'scans' },
    { from: 'camera', to: 'computer', interface: 'USB 3', kind: 'data', label: 'depth' },
    { from: 'computer', to: 'mcu', interface: 'UART 921600', kind: 'control', label: 'velocity' },
    { from: 'mcu', to: 'computer', interface: 'UART 921600', kind: 'data', label: 'odometry' },
    { from: 'mcu', to: 'motors', interface: 'PWM + encoders', kind: 'control' },
    { from: 'fleet', to: 'computer', interface: 'Wi-Fi MQTT', kind: 'data', label: 'jobs' },
  ],
}, null, 2);

// The second version has the parts the scout recommended
const SYSTEM_V2 = (() => {
  const sys = JSON.parse(SYSTEM_V1);
  const parts = { battery: '24 V 20 Ah LiFePO4', lidar: 'RPLIDAR S2', camera: 'Intel RealSense D435i', computer: 'Jetson Orin Nano 8GB', mcu: 'STM32G474 (B-G474E-DPOW1)', motors: '2x 200 W hub motor' };
  for (const b of sys.blocks) b.part = parts[b.id] ?? b.part;
  return JSON.stringify(sys, null, 2);
})();

const SYSTEM_MD = `# System architecture (demo)

The main computer plans paths from LiDAR and camera data and sends wheel speeds to a
motor controller, which closes the speed loop and owns the emergency stop.
`;

const OPTIONS = `# Hardware options (demo, checked 2026-10-12)

## Main computer
| Part | Key specs | Price | Lifecycle | Datasheet |
|---|---|---|---|---|
| **Jetson Orin Nano 8GB** (recommended) | 40 TOPS, 4x USB 3 | ~$249 | active | nvidia.com |
| Raspberry Pi 5 8GB | no GPU for vision | ~$80 | active | raspberrypi.com |

Recommended: Jetson, because the depth camera needs GPU inference; costs more and draws up to 15 W.
`;

const ARCH_REVIEW = `VERDICT: approve

1. (medium) battery → computer: no power budget for the 12 V rail; add peak current per load.
2. (medium) mcu: the e-stop path depends on UART; add a hardware e-stop input to the motor driver.
`;

export default {
  delayMs: 450,
  turns: {
    architect: [
      {
        thinking: 'Breaking the system into blocks and interfaces…\n\n',
        files: { '.devcrew/system.json': SYSTEM_V1, '.devcrew/SYSTEM.md': SYSTEM_MD },
        message: 'First system architecture: 7 blocks, 8 links.',
        tokens: { input: 16000, output: 2600 },
      },
      {
        thinking: 'Applying your feedback and the chosen parts…\n\n',
        files: { '.devcrew/system.json': SYSTEM_V2, '.devcrew/SYSTEM.md': SYSTEM_MD },
        message: 'Updated the architecture with the recommended parts.',
        tokens: { input: 23000, output: 2400, cached: 14000 },
      },
    ],
    scout: [{
      thinking: 'Searching for parts that fit each block…\n\n',
      files: { '.devcrew/hardware/options.md': OPTIONS },
      commands: ['WebSearch: Jetson Orin Nano price Thailand', 'WebSearch: STM32G474 motor control board'],
      message: 'Found 2-3 options per block.',
      tokens: { input: 34000, output: 3800 },
    }],
    arch: [{
      thinking: 'Checking interfaces, power and failure paths…\n\n',
      files: { '.devcrew/arch-review.md': ARCH_REVIEW },
      message: 'VERDICT: approve, 2 medium findings.',
      tokens: { input: 21000, output: 1600 },
    }],
  },
};
