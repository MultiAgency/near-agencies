# Draft: reference-instance access request (not posted)

For <https://github.com/fastnear/x402-facilitator/issues/new?template=access_request.yml>.
Title: `access: MultiAgency engagements (NEAR)`

Open items before posting:

- **Public URL:** there is none until the server is deployed over HTTPS.
- **Mainnet deposit amount:** the testnet demo uses 3 USDC, and the mainnet
  price is not set.
- **USDC registration:** `multiagency.sputnik-dao.near` must be registered on
  mainnet USDC. Readiness checklist item 1.

---

**Active reference networks**

- [x] near:testnet (staging)
- [x] near:mainnet

**Base Sepolia interest:** No Base Sepolia access needed

**Integration**

MultiAgency assembles human-AI teams for organizations. An organization opens
an engagement by paying a USDC deposit into the MultiAgency treasury: a Sputnik
DAO managed in Trezu. Contributors are then paid from that treasury by DAO
proposals once their work is accepted on a public kanban board.

The resource server has one paid route, `POST /engagements`. Software clients
(an organization's own agent) use it to open an engagement over x402 `exact`.
Humans pay the same deposit by a plain wallet transfer, which does not use the
facilitator.

Delivery is idempotent. The route declares the optional `payment-identifier`
extension, and identifiers are journaled durably before verification. A
byte-identical retry of a settled payment returns the original engagement, and
a reused identifier with a different payment gets 409. The engagement opens
only in the post-settlement hook. Source:
`lib/engagements.mjs` (`onEngagementRequest`, `mountEngagements`).

**Public resource-server URL or documentation**

`https://<deployment-host>/engagements`. Unpaid, it returns a canonical v2
402; the app is at `/`. To be filled in after deployment.

**Exact USDC recipients**

- near:testnet → `multiagency.sputnikv2.testnet`
- near:mainnet → `multiagency.sputnik-dao.near`

**Expected usage**

- Verify: at most 10 per minute. Settle: at most 2 per minute.
- Daily settlements: fewer than 10 during evaluation.
- Evaluation duration: 60 days.
- Amounts: one deposit per engagement. Testnet uses 3000000 atomic (3 USDC);
  the mainnet amount is to be set before posting.

**Wire transport:** Canonical x402 v2

**Acknowledgements**

- [x] This issue contains no secret or signed payment authorization.
- [x] Each deployed resource-server instance and environment will use its own credential.
- [x] I control, or am authorized to use, every listed recipient.
- [x] I understand access is exact-policy, bounded, revocable, and has no SLA.
- [x] I will complete read-only verification before settlement is enabled and will not ask the facilitator operator to fund payer wallets or manufacture activity.
