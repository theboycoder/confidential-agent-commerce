# Confidential Agent Commerce

**Two AI agents buy and sell from each other, and the price is encrypted on a
public blockchain.** Anyone can see that a payment happened. Only the buyer,
the seller, and a registered auditor can see how much.

**[Try it live](https://confidential-agent-commerce.vercel.app)** — press one
button and watch a real payment happen on Stellar testnet in about 20 seconds.
([recording](./demo.webm), in case testnet is reset.)

## Why this is hard

A public blockchain is public. If two businesses settle on-chain, their
competitors read every price they pay. That is why serious commerce doesn't
run on transparent ledgers — and why hiding the amount *completely* isn't the
answer either: a regulator that cannot audit is a regulator that says no.

This does both. The amount is invisible to the public **and** always readable
by a designated auditor — enforced by the cryptography, not by a promise. The
proof literally will not verify unless the auditor's copy is included.

## One payment, four different views

| who | sees |
|---|---|
| the public (explorers, rivals) | a payment happened, and between whom — **never how much** |
| the seller | the exact amount, decrypted with its own key |
| the buyer | its own change, re-checked against the chain |
| the registered auditor | the amount, always — the proof is invalid without it |

## What happens when you press the button

1. **Pip** (buyer) compares quotes from two merchant agents, **Momo** and
   **Kiki**, and picks one.
2. They negotiate a price — neither side sees the other's number — or Pip pays
   a Machine Payments Protocol 402 challenge.
3. Pip builds an **UltraHonk zero-knowledge proof in your browser** and submits
   a `confidential_transfer` to OpenZeppelin's Confidential Token contract.
   *Open that transaction in any explorer: there is no amount, only
   elliptic-curve commitments.*
4. The merchant rebuilds its balance from public chain events, **decrypts** its
   own receiving balance, and ships the goods only if the decrypted amount
   matches the invoice — it trusts arithmetic, not Pip's word.
5. Pip verifies the merchant's signature and re-derives its own state
   **byte-for-byte against the commitments the chain holds**, so a lying
   archive or event feed is caught.

Full mechanics — commitments, key derivation, what the proof actually proves,
and why the auditor is not optional:
**[how it works](https://confidential-agent-commerce.vercel.app/how/)**

> **Status: testnet, alpha.** The demo's keys are published on purpose, so
> anyone can decrypt *this demo's* amounts — that is a property of the demo,
> not of the protocol. Confidentiality covers the **amount**; sender, recipient
> and timing stay public. The confidential key is derived deterministically
> from your Stellar key, so it cannot be rotated and offers no forward secrecy.
> OpenZeppelin's Confidential Tokens are testnet-only today.

## The market: two merchants, a buyer that shops

Momo and Kiki are two merchant agents running as live services with their own
keys, price profiles, and policies (same till software, different shops):

| merchant | list | floor (private) | pricing | terms (signed, fixed): min ticket | velocity |
|---|---|---|---|---|---|
| Momo | 5 XLM | 2 XLM | surge: +0.3 XLM per payment in the last hour, capped | 0.5 XLM | 6 / customer / hour |
| Kiki | 4 XLM | 3.5 XLM | flat, no surge | 1 XLM | 3 / customer / hour |

`GET /api/market` returns every merchant's live quote and track record (from
the chain, decrypted by each merchant's own key). Pip reads it and chooses by
a shopping policy: cheapest quote, most track record, or a named merchant. Then
it fetches that merchant's signed terms, negotiates within its private budget
(or pays an MPP challenge, below), pays confidentially, attests the invoice,
and the merchant decrypt-verifies before delivering. Every merchant endpoint
takes `?merchant=momo|kiki`.

What you see is a market: a busy Momo surges above a quiet Kiki and cools
again as the hour rolls (demand is measured from the chain head); Kiki
refuses lowballs its firm floor won't take; a cheap-and-unproven shop competes
with an expensive-and-established one, and the buyer decides.

**Pricing is yours to set, terms are not.** The configure panel drives list
price, private floor, surge and cap for each merchant, live. Min ticket and
velocity are deliberately fixed and signed: a verdict at the till has to be a
pure function of chain facts plus the merchant's published terms, otherwise
the refund worker cannot re-derive it later and would either refund delivered
goods (under stricter terms) or strand funds (under looser ones). We found
this the hard way while wiring the clock; the knobs came out.

## The clock: agents on their own schedule, coached live

**Start the clock** and Pip trades on a schedule (every 45 s to 5 min) for as
long as the tab is open: each tick it reads the market board, keeps a notebook
of how many times each merchant has served it this hour against that
merchant's signed velocity term, drops shops that have served it their maximum,
picks by its shopping policy, negotiates or pays the MPP challenge, and prints
a receipt. When every shop is at its limit, Pip sits the tick out rather than
pay to be declined at the till.

While the clock runs, every knob is a **directive**: change Momo's list price,
Pip's budget, its haggling style, its protocol, and the next tick trades on it;
Pip logs what changed (`directives applied this tick: Momo list 5 → 9`). Two
one-shot directives sit next to the clock: *buy now* and *skip next tick*. Our
agents are code, not language models, so a directive is a knob they read, not
a prompt they may ignore; that is the honest version of coaching for
rule-based agents. Untick *respects hourly limits* and Pip will pay past a
merchant's velocity term on purpose, so you can watch the till decline the
payment by policy and the refund path run.

The clock lives in your tab: close it and Pip stops; the merchants keep
running as services. Your own agent can keep its own clock:

```sh
cd agents && for i in 1 2 3; do node join.mjs --amount 3; sleep 120; done
```

A run we recorded while building this: tick 1 Pip buys the cheapest quote
(Kiki, 3.6 after haggling); we raise Momo's list price to 9 mid-run; tick 2
logs the directive and Momo now quotes 10.2, Pip still buys Kiki; tick 3 Pip's
notebook reads Kiki 3/3, it holds itself to Kiki's terms, switches to Momo and
haggles 10.2 down to its 6 XLM budget. Every one of those was a real
confidential transfer on testnet.

## Confidential MPP: a real Machine Payments Protocol charge, settled privately

`GET /api/mpp/brief?merchant=momo` speaks the [Machine Payments Protocol](https://mpp.dev)
(HTTP Payment Authentication) with a new payment method, `stellar` /
`confidential-charge`: a faithful sibling of the official `stellar`/`charge`
method (draft-stellar-charge-00) whose settlement is an OpenZeppelin
`confidential_transfer` instead of a SEP-41 `transfer`. The amount never
appears on-chain; the merchant verifies by decrypting it with its own key.

```
GET /api/mpp/brief?merchant=momo
  -> 402  WWW-Authenticate: Payment id=… method="stellar" intent="confidential-charge"
          request={amount, currency=<confidential token>, recipient, settlement:"confidential"}
pay the challenged amount with confidential_transfer, then
GET /api/mpp/brief?merchant=momo   Authorization: Payment <credential {type:"signedHash", hash, sourceSignature}>
  -> 200  Payment-Receipt: …   (merchant decrypted the amount; the chain never showed it)
```

The credential is the standard push-mode shape: `sourceSignature` is the
payer's Ed25519 signature over `"{challenge.id}:{hash}"`, binding this payer,
this payment, and this challenge (mppx HMAC-binds and expires challenges).
The verifier (`web/lib/mpp/server.ts`) checks the invocation is a
`confidential_transfer` to the merchant on the confidential token, verifies
the payer signature against the on-chain sender, then decrypts the transfer
with the merchant's key and compares it with the challenged amount.

Buy over MPP from your own agent, or set Pip's protocol to **MPP** in the
configure panel and watch the same handshake happen in your browser: 402,
challenge parsed with `mppx`, UltraHonk proof in the tab, credential, 200 with
a `Payment-Receipt`, and a receipt line reading `PAID VIA MPP
stellar/confidential-charge`. The verifier also applies the merchant's terms at
the till (min ticket, velocity, blocklist) to the decrypted amount, and a
decline comes back as an RFC 9457 problem with the reason.

```sh
cd agents && node mpp-buy.mjs --merchant momo   # or --merchant kiki
```

To our knowledge the first confidential-settlement MPP payment method. Built
on `mppx` (the protocol core); `@stellar/mpp`'s SEP-41 charge verifier cannot
accept a confidential transfer by design (it checks `transfer` events), which
is why this is a new method rather than a configuration.

## The 402-gated API (confidential x402)

`GET /api/brief` answers **HTTP 402 Payment Required** with a Stellar
confidential-transfer scheme. Pay the seller confidentially, retry with
`?tx=<hash>`, and the server verifies the payment **from the transaction
envelope alone**: it checks the invocation is a `confidential_transfer` to the
seller on the OpenZeppelin contract, is successful, and is recent. It cannot
read the amount; that is the point. On success it serves the product,
Ed25519-signed by the seller.

```sh
curl https://confidential-agent-commerce.vercel.app/api/brief
# 402 {"scheme":"stellar-confidential-transfer","payTo":"G...","contract":"C...","how":"..."}
curl "https://confidential-agent-commerce.vercel.app/api/brief?tx=<your confidential_transfer hash>"
# 200 {"paid":true,"brief":{...},"sha256":"...","signature":"...","signer":"G..."}
```

An agent that pays a metered API without the amount ever appearing on-chain.
Source: [`web/api/brief.ts`](web/api/brief.ts). Production would bind an
invoice nonce into the transfer so a payment cannot be replayed across
requests; here a 10-minute freshness window stands in for that.

## Add confidential payments to your own agent

The whole client side is one call to the SDK plus a contract invocation:

```js
import { deriveSk, deriveKeys, skSigningMessage, addressToField } from "stellar-confidential-token-sdk";
import { proveTransfer } from "stellar-confidential-token-sdk/node";
import { ChainClient, keypairSigner } from "stellar-confidential-token-sdk/chain";

const root = new Uint8Array(kp.signMessage(Buffer.from(skSigningMessage(TOKEN, kp.publicKey()))));
const { sk, addrF } = deriveSk(root, TOKEN, kp.publicKey());
const keys = deriveKeys(sk, addrF, addressToField(kp.publicKey()));      // nothing stored, ever

const { payload } = await proveTransfer({ keys, v, r, amount, pvkB: sellerViewingKey, kAudR: kAud, kAudS: kAud });
await client.invoke(TOKEN, "confidential_transfer", [addr(me), addr(seller), bytesVal(payload)], signer);
```

`agents/join.mjs` is the complete, runnable version (fund, register,
deposit, pay, ~80 lines).

## Repository layout

```
agents/   the two-agent commerce run as a Node script + receipts
          (receipt.json includes every tx hash and archived envelope XDRs)
web/      the site: one page that runs a real payment from the browser,
          plus /how — the documentation
```

## Run it yourself

The agents, headless:

```sh
cd agents
npm install
node agents-commerce.mjs      # fresh keypairs, friendbot-funded, ~60s
```

The site, locally:

```sh
cd web
npm install
npm run dev
```

## Built on

- [OpenZeppelin Confidential Tokens](https://github.com/OpenZeppelin/stellar-contracts) —
  the contracts (confidential balances, UltraHonk verifier, auditor registry),
  deployed on Stellar testnet.
- [`stellar-confidential-token-sdk`](https://github.com/aguilar1x/stellar-confidential-token-sdk)
  by aguilar1x — the conformant TypeScript client (key derivation, witness
  building, proving, state replay, chain verification).

## Caveats

Testnet only. The client SDK is v0.1.x and unaudited — do not hold value with
it. Confidential means the **amount** is hidden; addresses and the existence
of payments are public. The session keys in `web/src/session.json` are
published deliberately: testnet accounts holding nothing, so the page can run
the real client in your browser.

---

Part of an ongoing series of receipted experiments into what autonomous
agents can do on Stellar. An AI copilot was used during the build and its
knowledge gaps were logged as data (`agents/raven-e6-buildlog.json`).
