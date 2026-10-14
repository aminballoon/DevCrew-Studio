"""Hardware-in-the-loop grader for HW-01. Runs on the real board, under the port lock
taken by the grade command. Builds and uploads the workspace's firmware first."""
import datetime as dt, glob, json, os, subprocess, time
import pytest, serial

HOME = os.path.expanduser('~/DevCrew-HIL')
WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def port():
    for _ in range(40):
        p = glob.glob('/dev/cu.usbmodem*')
        if p: return p[0]
        time.sleep(0.25)
    raise RuntimeError('board not found on USB')

def hard_reset():
    subprocess.run([f'{HOME}/venv/bin/esptool.py', '--port', port(), '--after', 'hard_reset', 'chip_id'], capture_output=True, timeout=60)

class Board:
    def __init__(self): self.s = None
    def open(self):
        if self.s: self.s.close()
        for _ in range(40):
            try: self.s = serial.Serial(port(), 115200, timeout=0.05); return
            except Exception: time.sleep(0.25)
        raise RuntimeError('cannot open the port')
    def read(self, sec, until=None):
        out, end = '', time.time() + sec
        while time.time() < end:
            out += self.s.read(4096).decode(errors='replace')
            if until and until in out: break
        return out
    def boot(self):
        """Hard reset; True once the firmware answers and its uptime shows it really restarted.
        (USB re-enumerates on reset, so the READY line itself is usually missed.)"""
        hard_reset(); time.sleep(1.5); self.open()
        end = time.time() + 15
        while time.time() < end:
            try:
                st = json.loads(self.cmd('STATUS', 1.0))
                return st['uptimeMs'] < 15000
            except Exception:
                time.sleep(0.5)
        return False
    def uptime(self):
        return json.loads(self.cmd('STATUS'))['uptimeMs']
    def cmd(self, line, wait=2.0):
        self.s.reset_input_buffer(); self.s.write(line.encode() + b'\n')
        lines = self.read(wait, '\n').strip().splitlines()
        return lines[-1].strip() if lines else ''

def reply(b, line):
    try: return b.cmd(line)
    except IndexError: return ''

@pytest.fixture(scope='session')
def board():
    r = subprocess.run([f'{HOME}/venv/bin/pio', 'run', '-e', 'board', '-t', 'upload', '--upload-port', port()], cwd=WS, capture_output=True, text=True, timeout=900)
    assert r.returncode == 0, 'build or upload failed:\n' + (r.stdout + r.stderr)[-1500:]
    b = Board()
    b.boot_log = b.boot()
    yield b
    reply(b, 'RELAY 1 0')

def test_boots_with_all_relays_off(board):
    assert board.boot_log, 'the firmware did not answer STATUS after a reset'
    assert reply(board, 'RELAYS') == 'RELAYS 00000000'

def test_ping_and_unknown_commands(board):
    assert reply(board, 'PING') == 'PONG'
    assert reply(board, 'FLY 1').startswith('ERR')
    assert reply(board, 'RELAY 9 1').startswith('ERR')
    assert reply(board, 'RELAY 1 2').startswith('ERR')

def test_each_relay_reads_back_from_the_expander(board):
    for n in range(1, 9):
        assert reply(board, f'RELAY {n} 1') == 'OK'
        assert reply(board, 'RELAYS') == 'RELAYS ' + ''.join('1' if i == n else '0' for i in range(1, 9))
        assert reply(board, f'RELAY {n} 0') == 'OK'
    assert reply(board, 'RELAYS') == 'RELAYS 00000000'

def test_at_most_four_relays_on(board):
    for n in (1, 2, 3, 4): assert reply(board, f'RELAY {n} 1') == 'OK'
    assert reply(board, 'RELAY 5 1').startswith('ERR')
    assert reply(board, 'RELAYS') == 'RELAYS 11110000'
    for n in (1, 2, 3, 4): reply(board, f'RELAY {n} 0')
    assert reply(board, 'RELAYS') == 'RELAYS 00000000'

def test_relay_watchdog(board):
    assert reply(board, 'RELAY 6 1') == 'OK'
    time.sleep(20); assert reply(board, 'RELAY 6 1') == 'OK'   # refresh
    time.sleep(20); assert reply(board, 'RELAYS') == 'RELAYS 00000100'
    time.sleep(12); assert reply(board, 'RELAYS') == 'RELAYS 00000000'

def test_i2c_probe_is_honest(board):
    assert reply(board, 'I2CPROBE 0x20') == 'ACK'
    assert reply(board, 'I2CPROBE 0x51') == 'ACK'
    assert reply(board, 'I2CPROBE 0x27') == 'NACK'

def test_status_json(board):
    s = json.loads(reply(board, 'STATUS'))
    assert s['expander'] is True and s['rtc'] is True and s['relays'] == '00000000' and isinstance(s['uptimeMs'], int)

def test_rtc_is_real_and_survives_a_reset(board):
    assert reply(board, 'TIME 2031-02-03T04:05:06') == 'OK'
    assert reply(board, 'TIME 2031-02-30T04:05:06').startswith('ERR')
    t0 = time.time()
    assert board.boot(), 'the firmware did not come back after a reset'
    got = reply(board, 'TIME')
    assert got.startswith('TIME '), got
    elapsed = (dt.datetime.fromisoformat(got[5:]) - dt.datetime(2031, 2, 3, 4, 5, 6)).total_seconds()
    assert abs(elapsed - (time.time() - t0)) <= 3, f'RTC read {got} after {time.time() - t0:.0f}s'

def test_never_crashes(board):
    board.s.write(bytes(range(256)) * 4 + b'\n'); time.sleep(0.5)
    assert reply(board, 'X' * 200).startswith('ERR')
    assert reply(board, 'PING') == 'PONG'
    before = board.uptime()
    end = time.time() + 60
    while time.time() < end:
        board.s.write(b'STATUS\nRELAYS\nTIME\n'); board.read(0.5)
    assert board.uptime() >= before + 55_000, 'the board reset under load'
    assert reply(board, 'PING') == 'PONG'
