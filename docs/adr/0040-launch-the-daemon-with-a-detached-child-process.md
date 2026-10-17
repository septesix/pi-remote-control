# Launch the daemon with a detached child process

## Title

Launch the daemon with a detached child process

## Status

Accepted

## Context

`/remote-control` and `/remote-control-pair` start the singleton daemon on demand. The shim built that start command as a POSIX shell line and ran it through the host's command execution helper:

```text
PI_REMOTE_CONTROL_PI_ENTRY='…' nohup '…' '…' start </dev/null >/tmp/pi-remote-control.log 2>&1 &
```

That assumes three things that do not hold on Windows: an `sh` on `PATH`, a writable `/tmp`, and a shell to perform redirection. Git for Windows puts only `…\Git\cmd` on `PATH` by default, which contains `git.exe` and no `sh.exe`, so the spawn failed with `ENOENT`. The host execution helper reports a spawn error as a non-zero exit code without surfacing the error, and the shim ignored that result, so the only visible symptom was a ten-second readiness timeout pointing at `/tmp/pi-remote-control.log` — a file that was never created because the shell never ran. A daemon that dies immediately, for example on an unreachable `bindAddress`, was indistinguishable from a slow start.

Quoting Windows paths through a shell also proved fragile: `C:\Program Files\nodejs\node.exe` inside single quotes survives, but any additional interpolation layer interprets `\P` and `\n` and corrupts the command.

## Decision

Start the daemon as a detached child process of the TUI using `node:child_process` `spawn` with the resolved runner path, `detached: true`, `windowsHide: true`, and file descriptors for standard output and error. No shell is involved, and no path is quoted. The host entry point travels to the child in its environment as `PI_REMOTE_CONTROL_PI_ENTRY`, which keeps decision 0039 intact.

The daemon log defaults to `pi-remote-control.log` in the operating system temporary directory, resolved with `tmpdir()` rather than a literal `/tmp`, and `PI_REMOTE_CONTROL_LOG` overrides it. Readiness polling stays, but the loop also watches the child's `error` and `exit` events and stops early with the recorded failure, so a daemon that cannot start is reported within one poll interval instead of after the full budget. Exit listeners are removed once readiness resolves or rejects, so a later daemon exit is normal lifecycle and never becomes an unhandled rejection. Startup failure messages name the log file that actually received the daemon output.

If another Pi process wins the singleton lock while this one waits, the health check succeeds and the command proceeds.

## Consequences

Daemon startup works identically in POSIX shells, PowerShell, and cmd, and no longer depends on `sh`, `nohup`, or `/tmp` being present. Failures report the real cause and a real log path instead of a timeout.

Detached children are not reaped by the TUI process, so an unclean Pi exit can leave a stale `daemon.lock`; `status` already cleans that per decision 0010. Because readiness is polled instead of pushed, the first start still costs one health round trip.
