#!/usr/bin/env bash
# Regenerates src/data/__fixtures__/fractional-index-vectors.json from the server's
# Java implementation. Needs a JDK on PATH and the submodule checked out.
#
# The vectors are what stop src/data/order.ts drifting from
# com.noveltea.order.FractionalIndex. Drift there fails nowhere and silently orders
# an author's chapters differently on each device, so regenerate whenever the Java
# changes and commit the result alongside it.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
java_src="$root/vendor/noveltea-server/api/src/main/java/com/noveltea/order/FractionalIndex.java"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/com/noveltea/order"
cp "$java_src" "$work/com/noveltea/order/"
cp "$root/tooling/OrderVectorGen.java" "$work/Gen.java"

(cd "$work" && javac -d . com/noveltea/order/FractionalIndex.java Gen.java && java Gen) \
  > "$root/src/data/__fixtures__/fractional-index-vectors.json"

echo "wrote src/data/__fixtures__/fractional-index-vectors.json"
