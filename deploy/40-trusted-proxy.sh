#!/bin/sh
# Runs from the nginx image's /docker-entrypoint.d/ before nginx starts. Writes the
# include that deploy/nginx.conf pulls in, from NOVELTEA_TRUSTED_PROXY.
#
# Not envsubst: nginx.conf is full of $host / $uri / $scheme, which envsubst would blank.
set -eu

out=/etc/nginx/noveltea-realip.conf
cidr="${NOVELTEA_TRUSTED_PROXY:-}"

if [ -z "$cidr" ]; then
    : > "$out"
    exit 0
fi

# Comma- or space-separated CIDRs/addresses. Refuse anything that is not plain address
# characters: the value lands inside a config file.
case "$cidr" in
    *[!0-9a-fA-F:./,\ ]*) echo "NOVELTEA_TRUSTED_PROXY: not a CIDR list: $cidr" >&2; exit 1 ;;
esac

{
    for c in $(echo "$cidr" | tr ',' ' '); do
        echo "set_real_ip_from $c;"
    done
    echo "real_ip_header X-Forwarded-For;"
    echo "real_ip_recursive on;"
} > "$out"
