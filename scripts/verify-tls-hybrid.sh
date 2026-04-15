#!/bin/sh
# verify-tls-hybrid.sh
#
# Checks whether a host negotiates X25519MLKEM768 hybrid post-quantum TLS
# key exchange during the TLS 1.3 handshake.
#
# Usage:
#   ./scripts/verify-tls-hybrid.sh <hostname>
#
# Exit codes:
#   0 — hybrid X25519MLKEM768 negotiated (post-quantum ready)
#   1 — hybrid group NOT negotiated (classical only)
#   2 — usage error or openssl invocation failed
#
# Requirements:
#   openssl >= 3.2 with the -groups flag and X25519MLKEM768 support.
#   On macOS with Homebrew: brew install openssl@3 and use the correct path.

set -eu

HYBRID_GROUP="X25519MLKEM768"

if [ $# -lt 1 ] || [ -z "$1" ]; then
  echo "Usage: $0 <hostname>" >&2
  echo "Example: $0 instinct.wolfpackagency.com" >&2
  exit 2
fi

HOST="$1"

echo "Checking hybrid TLS posture for: ${HOST}:443"
echo "Target group: ${HYBRID_GROUP}"
echo ""

# Try to find an openssl binary with PQ support.
# Prefer system openssl, fall back to Homebrew paths.
OPENSSL_BIN="openssl"
if ! "${OPENSSL_BIN}" list -kem-algorithms 2>/dev/null | grep -qi "mlkem\|X25519MLKEM" 2>/dev/null; then
  for candidate in /opt/homebrew/opt/openssl@3/bin/openssl /usr/local/opt/openssl@3/bin/openssl; do
    if [ -x "$candidate" ] && "$candidate" list -kem-algorithms 2>/dev/null | grep -qi "mlkem\|X25519MLKEM" 2>/dev/null; then
      OPENSSL_BIN="$candidate"
      break
    fi
  done
fi

# Run the TLS handshake with X25519MLKEM768 in the group list.
# -brief reduces noise; pipe stderr+stdout for group negotiation output.
HANDSHAKE_OUTPUT=$("${OPENSSL_BIN}" s_client \
  -connect "${HOST}:443" \
  -groups "${HYBRID_GROUP}:X25519:P-256" \
  -brief \
  </dev/null 2>&1) || true

NEGOTIATED_GROUP=$(echo "${HANDSHAKE_OUTPUT}" | grep -i "server temp key\|key exchange\|group\|curve" | head -5)

echo "Handshake output (relevant lines):"
echo "${NEGOTIATED_GROUP:-  (no group/curve lines found)}"
echo ""

if echo "${HANDSHAKE_OUTPUT}" | grep -qi "${HYBRID_GROUP}"; then
  echo "RESULT: PASS — ${HYBRID_GROUP} negotiated. Hybrid post-quantum TLS is active."
  exit 0
else
  echo "RESULT: FAIL — ${HYBRID_GROUP} NOT negotiated. Classical TLS only."
  echo ""
  echo "Note: Hybrid PQ TLS requires both client and server to support X25519MLKEM768."
  echo "Server support depends on your TLS termination provider (Vercel, Cloudflare, etc.)."
  echo "Cloudflare and Chrome both support X25519MLKEM768 as of 2024."
  exit 1
fi
