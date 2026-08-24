/**
 * Server side of `stellar`/`confidential-charge`: build the Mppx instance for
 * a merchant and the verifier that decrypts the payment.
 */
import { Buffer } from "node:buffer";
import { Method, Errors } from "mppx";
import { Mppx } from "mppx/server";
import { Keypair, xdr, StrKey } from "@stellar/stellar-sdk";
import { confidentialCharge } from "./method.js";
import { momoBooks, RPC, SESSION } from "../momo.js";
import { decide } from "../policy.js";
import type { MerchantProfile } from "../merchants.js";

// mppx turns any non-PaymentError thrown from verify() into a bare "Verification Failed"; keep the reason.
const fail = (reason: string) => new Errors.VerificationFailedError({ reason });
/** tx hash -> XLM the merchant decrypted for it (per instance; lets the resource handler tell the buyer what was read). */
/**
 * The HMAC key that authenticates every payment challenge. There is NO
 * fallback on purpose: a literal here would be a public signing key (it was),
 * letting anyone forge a valid challenge for any amount. Fail loudly instead.
 */
function mppSecret(): string {
	const k = process.env.MPP_SECRET_KEY;
	if (!k || k.length < 16)
		throw new Error(
			"MPP_SECRET_KEY is unset (or too short) — refusing to sign payment challenges with a guessable key",
		);
	return k;
}

export const decryptedFor = new Map<string, number>();

export function confidentialChargeServer(M: MerchantProfile) {
  return Method.toServer(confidentialCharge, {
    defaults: { currency: SESSION.contracts.token, recipient: M.address, settlement: "confidential" as const },
    async verify({ credential, request }) {
      const { hash, sourceSignature } = credential.payload;
      const tx = hash.toLowerCase();
      const expectedStroops = BigInt(request.amount);
      // 1. the tx exists, succeeded, and is a confidential_transfer to this merchant on the confidential token
      const tr = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: { hash: tx } }) }).then((r) => r.json());
      const t = tr.result;
      if (!t || t.status !== "SUCCESS") throw fail("payment tx not found or not successful");
      const env = xdr.TransactionEnvelope.fromXDR(t.envelopeXdr, "base64");
      const ops = env.v1().tx().operations();
      if (ops.length !== 1) throw fail("expected a single operation");
      const b = ops[0].body();
      if (b.switch().name !== "invokeHostFunction") throw fail("not a contract invocation");
      const inv = b.invokeHostFunctionOp().hostFunction().invokeContract();
      const contract = StrKey.encodeContract(inv.contractAddress().contractId());
      const fn = inv.functionName().toString();
      const args = inv.args();
      const from = StrKey.encodeEd25519PublicKey(args[0].address().accountId().ed25519());
      const to = StrKey.encodeEd25519PublicKey(args[1].address().accountId().ed25519());
      if (contract !== request.currency) throw fail("wrong token contract");
      if (fn !== "confidential_transfer") throw fail(`function must be confidential_transfer, got ${fn}`);
      if (to !== request.recipient) throw fail("payment is not to this merchant");
      // 2. payer binding: sourceSignature over "{challenge.id}:{hash}" by the on-chain payer
      const msg = Buffer.from(`${credential.challenge.id}:${tx}`);
      const ok = Keypair.fromPublicKey(from).verify(msg, Buffer.from(sourceSignature, "hex"));
      if (!ok) throw fail("sourceSignature does not verify against the on-chain payer");
      // 3. THE CONFIDENTIAL PART: decrypt the amount with the merchant's own key; the chain never showed it
      const { inbound, engine } = await momoBooks(M);
      const ev: any = inbound.find((e: any) => String(e.txHash).toLowerCase() === tx);
      if (!ev) throw fail("payment not yet visible in the merchant's replayed events; retry shortly");
      const paidStroops = typeof ev.amount === "number" ? BigInt(Math.round(ev.amount * 1e7)) : BigInt(engine.decryptIncoming(ev.rE, ev.vTilde, ev.sigma).vTx);
      if (paidStroops < expectedStroops) throw fail(`decrypted amount ${paidStroops} < required ${expectedStroops}`);
      // 4. policy at the till, same terms as the negotiated path: min ticket, velocity, blocklist, on the DECRYPTED payment
      const paidXlm = Number(paidStroops) / 1e7;
      const customerLedgers = (inbound as any[]).filter((e) => e.from === ev.from).map((e) => e.ledger as number);
      const verdict = decide({ from: ev.from, paidXlm, ledger: ev.ledger, customerLedgers }, M);
      decryptedFor.set(tx, paidXlm);
      if (!verdict.allow) throw fail(`policy at the till declined delivery (${verdict.rule}: ${verdict.reason}); the payment is held in the merchant's confidential balance, refundable`);
      return { method: "stellar", reference: tx, externalId: request.externalId, status: "success" as const, timestamp: new Date().toISOString() };
    },
  });
}

export function mppFor(M: MerchantProfile) {
  return Mppx.create({
    secretKey: mppSecret() + M.id,
    methods: [confidentialChargeServer(M)],
  });
}
