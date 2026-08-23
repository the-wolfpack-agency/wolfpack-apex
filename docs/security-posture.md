# Wolfpack Instinct — Security Posture

## Executive Summary

Wolfpack Instinct is designed crypto-agile and post-quantum migration-ready. All data in transit is protected by hybrid TLS (classical ECDH + ML-KEM-768 where the client supports it). Secrets held on a customer's behalf, meaning integration credentials, OAuth refresh tokens, multi-factor seeds and compliance evidence, are encrypted by the application with AES-256-GCM before they are written. The remaining application data is protected by the managed database's own volume encryption rather than by per-column encryption, and the difference is set out in the table below. Session tokens are short-lived by design so the harvest-now-decrypt-later attack window for authentication material is minutes, not years.

## Current Crypto Inventory

| Asset | Algorithm | Quantum-Resistant? | Notes |
|---|---|---|---|
| TLS in transit | TLS 1.3 + X25519MLKEM768 (hybrid KEX) | Yes (hybrid) | Classical fallback to X25519 when client does not support PQ extension |
| Integration credentials, OAuth refresh tokens, MFA seeds, compliance evidence | AES-256-GCM, encrypted by the application | Yes | Grover's algorithm halves effective key size to 128 bits, which is still beyond brute-force reach. Ciphertext is what reaches the database, so a database read alone does not yield the secret |
| Other application data at rest (messages, documents, records) | AES-256 at the storage volume, managed by the database provider | Yes | Protects against loss of the physical media. It is NOT per-column encryption: anything able to query the database reads plaintext, so access control and the audit log are the controls that matter here, not cryptography |
| Session tokens | JWT (HS256), 15-minute TTL | Partial | HS256 uses a symmetric key; HMAC-SHA256 is quantum-resistant. Short TTL limits harvest risk. |
| Refresh tokens | Opaque random (256-bit), single-use rotation | Yes | Rotation + revocation means a stolen token has a narrow replay window |
| Password hashing | bcrypt (cost 12) | Yes | Bcrypt's work factor limits quantum speedup; argon2id migration planned (2027) |
| Signed documents / JWTs with long TTL | ECDSA P-256 | No (Shor-breakable) | Mitigation: no long-lived JWTs issued; crypto-agility wrapper reserves ML-DSA slot |

## Known Weaknesses

- **ECDSA / RSA signatures** — Shor's algorithm on a Cryptographically Relevant Quantum Computer (CRQC) can break P-256 and RSA-2048 in polynomial time. No CRQC exists today; current estimates put CRQC capability at 2030–2035 at the earliest.
- **Harvest-now-decrypt-later (HNDL)** for auth tokens — an adversary archiving today's encrypted traffic could attempt to decrypt session tokens once a CRQC is available. Our mitigation: 15-minute JWT TTL means archived tokens expire before a CRQC could be weaponised.
- **bcrypt vs argon2id** — bcrypt is not memory-hard; argon2id provides better resistance to GPU/quantum-accelerated cracking. Migration is planned.

## Migration Roadmap

| Year | Action |
|---|---|
| 2026 (now) | Crypto-agility wrapper deployed with ML-DSA (FIPS 204) slot reserved; hybrid TLS active |
| 2027 | Evaluate production-grade ML-DSA signing libraries for Node.js; pilot on internal signing paths |
| 2028–2029 | Migrate all signature operations to ML-DSA once FIPS 204 library ecosystem matures |
| 2029+ | Rotate remaining ECDSA keys; deprecate RSA; full PQ posture achieved |
| Ongoing | Quarterly key rotation; annual crypto inventory review |

## What This Means for Customers

Any data you transmit to Wolfpack Instinct today is protected by hybrid TLS, a combination of classical elliptic-curve cryptography and the post-quantum ML-KEM-768 algorithm. Even if a quantum computer became available tomorrow, an attacker who captured your traffic today could not decrypt it.

Once your data is stored, two different protections apply and it is worth being precise about which. Credentials we hold on your behalf are encrypted by the application before they are written, so the database holds ciphertext and reading the database is not enough to recover them. Your ordinary content is protected by encryption of the underlying storage, which defends against loss of the physical media and does not defend against anything holding a valid database connection. For that content the controls that matter are access control, tenant isolation and the append-only audit log, and we would rather say so than describe it as encrypted and let you assume the stronger meaning.

Short-lived session tokens mean the worst-case exposure window for authentication material is 15 minutes. Refresh tokens are single-use and rotated on every use, so a stolen token can only be replayed once before it is invalidated.

## Transparency

This document is maintained by the Wolfpack engineering team and updated at least quarterly. It is publicly accessible at `/security-posture`.

**Follow-up actions (not yet complete):**
- After HSTS has been live in production for >1 week, submit the domain to [https://hstspreload.org](https://hstspreload.org) to be included in browser preload lists.
- Monitor the [NIST PQC standards](https://csrc.nist.gov/projects/post-quantum-cryptography) for final FIPS 204 (ML-DSA) and FIPS 205 (SLH-DSA) publications.
