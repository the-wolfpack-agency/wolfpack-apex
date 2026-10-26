# Wolfpack Instinct: Security Posture

## Executive Summary

Wolfpack Instinct is designed to be crypto-agile and post-quantum migration-ready. Data in transit is protected by hybrid TLS (classical ECDH + ML-KEM-768 where the client supports it). Integration credentials, multi-factor seeds, and Microsoft Graph and QuickBooks OAuth tokens are encrypted by the application with AES-256-GCM under a dedicated encryption key before they are written. Team invite tokens are stored as one-way hashes for new invites; invites issued earlier are converted by a one-time backfill that has not yet run. The remaining application data is protected by the managed database's own volume encryption rather than by per-column encryption, and the difference is set out in the table below. Session tokens are short-lived by design, so the harvest-now-decrypt-later window for authentication material is minutes, not years.

This page states what is true today. Each control below names the evidence that proves it, and an automated parity check compares this page with that evidence: a control may only be listed as "In place" while its evidence check passes. Work that has started but is not finished is listed as "In progress", never as done.

## Control status

| Control | Status | Evidence key |
|---|---|---|
| Data in transit protected by hybrid post-quantum TLS (X25519MLKEM768) where the client supports it | In place. A TLS 1.3 handshake to the production domain negotiated X25519MLKEM768 on 2026-10-24 | `tls.hybrid_kex` |
| Hybrid TLS asserted continuously in CI | Not in place. The CI handshake check exists but is not yet configured to run | `tls.hybrid_ci_asserted` |
| Integration credentials and MFA seeds encrypted by the application under a dedicated key | In place. Stored as AES-256-GCM ciphertext under a dedicated key; every stored value was re-encrypted under that key on 2026-10-25 | `secrets.app_encrypted` |
| Microsoft Graph and QuickBooks OAuth tokens encrypted by the application | In place. Encrypted with AES-256-GCM before they are written; a token that cannot be encrypted is not stored | `secrets.oauth_tokens_encrypted` |
| Tenant isolation by a workspace predicate on every workspace-scoped query, enforced by a build-failing guardrail | In place | `isolation.app_predicate` |
| Database row-level security enforcing tenant isolation | Not in place. Some tables have row-level security enabled with permissive policies, which do not isolate tenants | `isolation.db_rls` |
| Multi-factor authentication enforced for administrators | Not in place. Enrollment exists; sign-in does not yet require a second factor | `auth.mfa_enforced` |
| Session access tokens expire after 15 minutes | In place | `auth.short_access_tokens` |
| Append-only, hash-chained audit log, verified on a schedule | In place | `audit.hash_chain` |
| Agent-action ledger checkpoints cryptographically signed | Not in place. The signing path is built; production checkpoints are not yet signed | `signing.ledger_checkpoints` |
| CodeQL findings fail the build | Not in place. CodeQL runs on every pull request but is not a required check | `ci.codeql_required` |

## Current Crypto Inventory

| Asset | Algorithm | Quantum-Resistant? | Notes |
|---|---|---|---|
| TLS in transit | TLS 1.3 + X25519MLKEM768 (hybrid KEX) | Yes (hybrid) | Classical fallback to X25519 when the client does not support the PQ extension |
| Integration credentials, MFA seeds | AES-256-GCM, encrypted by the application under a dedicated key | Yes | Grover's algorithm halves effective key size to 128 bits, still beyond brute-force reach. The key can be rotated while stored values stay readable |
| Microsoft Graph and QuickBooks OAuth tokens | AES-256-GCM, encrypted by the application under the same dedicated key | Yes | A database connection alone does not reveal these tokens; the encryption key is held outside the database |
| Team invite tokens | SHA-256 one-way hash | Yes | New invites are stored only as a hash. Invites issued before hashing was introduced on 2026-10-26 are converted to hashes by a one-time backfill, which has not yet run |
| Other application data at rest (messages, documents, records, compliance evidence) | AES-256 at the storage volume, managed by the database provider | Yes | Protects against loss of the physical media. It is NOT per-column encryption: anything able to query the database reads plaintext, so access control and the audit log are the controls that matter here, not cryptography |
| Session tokens | JWT (HS256), 15-minute TTL | Partial | HS256 uses a symmetric key; HMAC-SHA256 is quantum-resistant. Short TTL limits harvest risk |
| Refresh tokens | Opaque random (256-bit), single-use rotation | Yes | Rotation + revocation means a stolen token has a narrow replay window |
| Password hashing | bcrypt (cost 12) | Yes | Bcrypt's work factor limits quantum speedup; argon2id migration planned (2027) |
| Agent delegation credentials and ledger checkpoints | ECDSA P-256 (ES256) | No (Shor-breakable) | Delegations from ES256 issuers are verified with ECDSA. Ledger checkpoint signing is built but not yet active in production. The crypto-agility wrapper reserves an ML-DSA slot |

## Known Weaknesses

- **Older team invite tokens not yet hashed.** Invites issued before hashing was introduced on 2026-10-26 are still stored as issued until a one-time conversion runs. New invites are stored only as a hash.
- **No database-level tenant isolation.** Tenant isolation is enforced in the application by a workspace predicate on every query and a build-failing guardrail. Row-level security in the database does not enforce it.
- **MFA is not enforced.** Administrators can enroll a second factor, but sign-in does not require it yet.
- **ECDSA / RSA signatures.** Shor's algorithm on a Cryptographically Relevant Quantum Computer (CRQC) can break P-256 and RSA-2048 in polynomial time. No CRQC exists today; current estimates put CRQC capability at 2030 to 2035 at the earliest.
- **Harvest-now-decrypt-later (HNDL) for auth tokens.** An adversary archiving today's encrypted traffic could attempt to decrypt session tokens once a CRQC is available. Our mitigation: the 15-minute JWT TTL means archived tokens expire long before a CRQC could be used.
- **bcrypt vs argon2id.** bcrypt is not memory-hard; argon2id provides better resistance to GPU-accelerated cracking. Migration is planned.

## Migration Roadmap

| Year | Action |
|---|---|
| 2026 (now) | Crypto-agility wrapper deployed with ML-DSA (FIPS 204) slot reserved; hybrid TLS active; integration credentials, MFA seeds and OAuth tokens encrypted by the application under a dedicated key |
| 2027 | Evaluate production-grade ML-DSA signing libraries for Node.js; pilot on internal signing paths |
| 2028 to 2029 | Migrate all signature operations to ML-DSA once the FIPS 204 library ecosystem matures |
| 2029+ | Rotate remaining ECDSA keys; deprecate RSA; full PQ posture achieved |
| Ongoing | Quarterly key rotation; annual crypto inventory review |

## What This Means for Customers

Any data you transmit to Wolfpack Instinct today is protected by hybrid TLS, a combination of classical elliptic-curve cryptography and the post-quantum ML-KEM-768 algorithm, when your client supports it. An attacker who captured that traffic today could not decrypt it with a future quantum computer.

Once your data is stored, different protections apply and it is worth being precise about which. Integration credentials and Microsoft Graph and QuickBooks connection tokens we hold on your behalf are encrypted by the application under a dedicated key before they are written, so a database connection alone does not reveal them. Your ordinary content is protected by encryption of the underlying storage, which defends against loss of the physical media and does not defend against anything holding a valid database connection. For that content the controls that matter are access control, tenant isolation in the application, and the append-only audit log, and we would rather say so than describe it as encrypted and let you assume the stronger meaning.

Short-lived session tokens mean the worst-case exposure window for authentication material is 15 minutes. Refresh tokens are single-use and rotated on every use, so a stolen token can only be replayed once before it is invalidated.

## Transparency

This document is maintained by the Wolfpack engineering team and updated at least quarterly. It is publicly accessible at `/security-posture`. The Control status table is checked against measured evidence by an automated parity check; a control is moved to "In place" only in the same change that makes its evidence check pass.

**Follow-up actions (not yet complete):**
- Convert team invite tokens issued before hashing was introduced to one-way hashes.
- Enforce MFA at sign-in for administrators.
- Configure the CI hybrid-TLS handshake check so the TLS claim is asserted continuously.
- Make CodeQL a required check on the main branch.
- Submit the domain to [https://hstspreload.org](https://hstspreload.org) for browser preload lists (HSTS with preload is already served).
- Monitor the [NIST PQC standards](https://csrc.nist.gov/projects/post-quantum-cryptography) for FIPS 204 (ML-DSA) and FIPS 205 (SLH-DSA) library maturity.
