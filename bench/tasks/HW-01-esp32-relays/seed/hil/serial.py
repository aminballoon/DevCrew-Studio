#!/usr/bin/env python3
"""Send commands to the board and print each reply, or listen: serial.py --listen <seconds>."""
import glob, os, subprocess, sys
if os.environ.get('HIL_LOCKED') != '1':
    os.environ['HIL_LOCKED'] = '1'
    sys.exit(subprocess.call([os.path.expanduser('~/DevCrew-HIL/bin/hil-locked'), os.path.expanduser('~/DevCrew-HIL/venv/bin/python'), *sys.argv]))
# This file is named serial.py: drop its own folder from the path so pyserial is imported, not this file.
here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if os.path.abspath(p or '.') != here]
import time, serial
ports = glob.glob('/dev/cu.usbmodem*')
if not ports: sys.exit('board not found on USB')
s = serial.Serial(ports[0], 115200, timeout=0.1)
def read_for(sec, until_line=False):
    out, end = b'', time.time() + sec
    while time.time() < end:
        out += s.read(4096)
        if until_line and out.endswith(b'\n'): break
    return out.decode(errors='replace')
if sys.argv[1:2] == ['--listen']:
    print(read_for(float(sys.argv[2]) if len(sys.argv) > 2 else 5), end='')
    sys.exit(0)
s.reset_input_buffer()
for cmd in sys.argv[1:]:
    s.write(cmd.encode() + b'\n')
    print(f'> {cmd}\n{read_for(2, True).strip() or "(no reply)"}')
