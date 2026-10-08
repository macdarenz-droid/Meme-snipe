# A fresh Ubuntu 24.04 with systemd as PID 1, standing in for a new Vultr server (ops/test/e2e.sh). openssh-server, as
# on Vultr's image, so the pull account's sshd settings are checked (PATHS-FIX).
FROM ubuntu:24.04
RUN apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends \
      systemd systemd-sysv dbus curl ca-certificates iproute2 openssh-server && apt-get clean && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
