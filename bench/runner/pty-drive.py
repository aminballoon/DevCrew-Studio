"""Run an interactive Claude Code session unattended, for workflows that need a terminal (agent teams).

The session gets its prompt on the command line. A Stop hook appends to the marker file each time
the lead's turn ends; the session counts as finished once that happened and no transcript under
the watched folder has changed for --idle seconds (teammates still working keep writing). Then it
is asked to exit, and killed if it does not.

Usage: python3 pty-drive.py --marker F --watch DIR --deadline SECS --log F [--idle SECS] -- claude ...
"""
import argparse, fcntl, os, pty, re, select, signal, struct, sys, termios, time

ap = argparse.ArgumentParser()
ap.add_argument('--marker', required=True)
ap.add_argument('--watch', required=True)
ap.add_argument('--deadline', type=float, required=True)
ap.add_argument('--log', required=True)
ap.add_argument('--idle', type=float, default=90)
ap.add_argument('cmd', nargs=argparse.REMAINDER)
args = ap.parse_args()
cmd = args.cmd[1:] if args.cmd[:1] == ['--'] else args.cmd

pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 200, 0, 0))

ANSI = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[=>]')
start = time.time()
tail = ''
trusted = False
log = open(args.log, 'ab')


def last_change(folder):
    newest = 0.0
    for root, _, files in os.walk(folder):
        for f in files:
            try:
                newest = max(newest, os.path.getmtime(os.path.join(root, f)))
            except OSError:
                pass
    return newest


reaped = False


def alive():
    global reaped
    if not reaped:
        try:
            reaped = os.waitpid(pid, os.WNOHANG)[0] != 0
        except ChildProcessError:
            reaped = True
    return not reaped


def write(text):
    try:
        os.write(fd, text.encode())
    except OSError:
        pass


outcome = 'deadline'
exit_sent = None
while True:
    if not alive():
        outcome = 'finished' if exit_sent else 'exited'
        break
    ready, _, _ = select.select([fd], [], [], 1.0)
    if ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b''
        if data:
            log.write(data)
            log.flush()
            tail = (tail + ANSI.sub(' ', data.decode('utf-8', 'replace')))[-4000:]
    # The trust question for the new workspace and the permissions it pre-approves: "No, exit" is
    # first and selected, so move down to "Yes, I trust this folder" before confirming
    if not trusted and re.search(r'Yes,\s+I\s+trust\s+this\s+folder', tail) and 'Enter to confirm' in re.sub(r'\s+', ' ', tail):
        time.sleep(0.5)
        write('\x1b[B')
        time.sleep(0.3)
        write('\r')
        trusted = True
        tail = ''
    now = time.time()
    if now - start > args.deadline:
        break
    if exit_sent is None and os.path.exists(args.marker) and now - last_change(args.watch) > args.idle:
        write('/exit\r')
        exit_sent = now
    if exit_sent is not None and now - exit_sent > 20:
        outcome = 'finished'
        break

if alive():
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pid, sig)
        except OSError:
            pass
        time.sleep(3)
        if not alive():
            break
print(outcome)
sys.exit(0 if outcome in ('finished', 'exited') else 2)
