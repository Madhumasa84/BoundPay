#!/bin/sh
set -eu

drunix_root=${1:?usage: prepare-drunix-local-network.sh /path/to/npci/drunix}
expected_commit=3fb2b135a5b2adf7e1071d9b1624052a1bbb1772
actual_commit=$(git -C "$drunix_root" rev-parse HEAD)
if [ "$actual_commit" != "$expected_commit" ]; then
  echo "Expected Drunix v1.0.0 commit $expected_commit, got $actual_commit" >&2
  exit 1
fi

compose_file="$drunix_root/drunix-network/test-network/scripts/yugabyte/compose.yaml"
if [ ! -f "$compose_file" ]; then
  echo "Drunix v1.0.0 Yugabyte compose file not found: $compose_file" >&2
  exit 1
fi

replace_config_value() {
  file=$1
  original=$2
  replacement=$3
  expected_count=$4
  replacement_file=$(mktemp "$file.boundpay.XXXXXX")
  # Compare whole YAML values literally: regex metacharacters and an image name
  # that is a prefix of its pinned digest must not affect matching.
  if awk -v original="$original" -v replacement="$replacement" -v expected="$expected_count" '
    {
      value = $0
      if (sub(/^[[:space:]]*(image|builder|runtime|command):[[:space:]]*/, "", value)) {
        if (value == original) {
          originals++
          print substr($0, 1, length($0) - length(value)) replacement
          next
        }
        if (value == replacement) replacements++
      }
      print
    }
    END {
      if (!((originals == expected && replacements == 0) ||
            (originals == 0 && replacements == expected))) exit 1
    }
  ' "$file" > "$replacement_file"; then
    mv "$replacement_file" "$file"
  else
    rm -f "$replacement_file"
    echo "Unexpected configuration in $file; refusing to patch $original" >&2
    exit 1
  fi
}

replace_config_value "$compose_file" '["bin/yugabyted", "start", "--background=false"]' '["bin/yugabyted", "start", "--background=false", "--master_flags=max_clock_skew_usec=1500000", "--tserver_flags=max_clock_skew_usec=1500000"]' 2

network_compose="$drunix_root/drunix-network/test-network/compose/compose-test-net.yaml"
docker_compose="$drunix_root/drunix-network/test-network/compose/docker/docker-compose-test-net.yaml"
peer_config="$drunix_root/drunix-network/test-network/compose/docker/peercfg/core.yaml"
for file in "$network_compose" "$docker_compose"; do
  replace_config_value "$file" 'npcioss/drunix-peer:1.0.0' 'npcioss/drunix-peer@sha256:dac28b37f9bd724d34edb7f1c20ca5b987667efa3270809f2ed1507fcf5f754f' 4
  replace_config_value "$file" 'npcioss/drunix-vscc:1.0.0' 'npcioss/drunix-vscc@sha256:9156b22fb4c9a02747d30515ec7e04183f246fea02df8edfc1d0821c496f6664' 2
done
replace_config_value "$network_compose" 'npcioss/drunix-orderer:1.0.0' 'npcioss/drunix-orderer@sha256:991da76f33c87459667b9f815eb44fb63f160c9fb5dcb114ed7b70491c9fda7b' 1
replace_config_value "$compose_file" 'yugabytedb/yugabyte:2025.2.0.0-b131' 'yugabytedb/yugabyte@sha256:3f7607281e9169597948792969a984f98683fa1cc327a920fed250616bf5e8d2' 2
replace_config_value "$compose_file" 'eqalpha/keydb' 'eqalpha/keydb@sha256:6537505c42355ca1f571276bddf83f5b750f760f07b2a185a676481791e388ac' 2
replace_config_value "$peer_config" '$(DOCKER_NS)/drunix-ccenv:$(TWO_DIGIT_VERSION)' 'npcioss/drunix-ccenv@sha256:769082d57a8c4aadce47f10c55c8732c0e6c87665cfc9eb47cb929283b7a2b8f' 1
replace_config_value "$peer_config" '$(DOCKER_NS)/drunix-baseos:$(TWO_DIGIT_VERSION)' 'npcioss/drunix-baseos@sha256:d110fe483eb8dbde03ca5bb04098db0ebcd1596b1e439abb8c92e3710285e585' 1
echo "Applied Drunix image digests and a local-test-only Yugabyte max_clock_skew_usec=1500000 override"
