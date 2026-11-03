#!/usr/bin/env bash
# CI only (GitHub's throwaway ubuntu-latest runner). Ubuntu 24.04 restricts unprivileged user
# namespaces with AppArmor: bubblewrap may start, but Claude Code's sandbox also sets up a user
# namespace nested inside bubblewrap's (its seccomp helper writes /proc/self/setgroups), and
# AppArmor strips the capabilities that needs, so every sandboxed command fails with
# "apply-seccomp: ... Permission denied". Lift the restriction on the runner, then prove the nested
# namespace works, so the tests that need the sandbox run here instead of being skipped. (Crew
# itself reports the sandbox as unavailable wherever this probe fails: server/sandbox.ts.)
set -euo pipefail

probe() {
  bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --die-with-parent -- unshare --user --map-root-user /bin/true
}

echo "kernel.apparmor_restrict_unprivileged_userns=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo n/a)"
ls /etc/apparmor.d 2>/dev/null | grep -iE 'bwrap|userns' || true

if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi
# A bwrap profile that moves what bwrap runs into a capability-less child profile would still
# block the nested namespace: unload it.
for f in /etc/apparmor.d/bwrap-userns-restrict /etc/apparmor.d/bwrap; do
  if [ -e "$f" ]; then sudo apparmor_parser -R "$f" || true; fi
done

if probe; then
  echo "bubblewrap can nest a user namespace: the sandbox tests will run."
else
  echo "::error::bubblewrap still cannot nest a user namespace; the sandbox tests would be skipped."
  exit 1
fi
