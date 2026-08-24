/**
 * One button, one REAL confidential payment on Stellar testnet.
 *
 * Everything happens in this tab: the buyer's zero-knowledge proof is
 * generated in your browser (UltraHonk via wasm), the transfer is submitted
 * to the live contract, and the seller confirms payment by decrypting its
 * own receiving balance from public chain events. Every run is a new
 * on-chain transaction, the price is random each time and never visible
 * on-chain.
 *
 * Session keys are published testnet keys holding nothing (deliberate, the
 * SDK demo's own precedent), so the page can run the real client.
 */
import { Buffer } from "buffer";
(globalThis as any).Buffer = Buffer;

import SESSION from "./session.json";
import { blobAvatar } from "./avatar";
import { discloseToExaminer } from "./disclose";

// the site redeploys often; if an old tab's lazy chunk 404s, reload once
window.addEventListener("vite:preloadError", () => window.location.reload());

const $ = (id: string) => document.getElementById(id)!;
const STROOP = 10_000_000n;
const RPC = "https://soroban-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";

// ── chat rendering ──────────────────────────────────────────────────────────
let lastSide = "";
function ensureName(side: "pip" | "momo") {
  if (lastSide === side) return;
  lastSide = side;
  const n = document.createElement("div");
  n.className = `name ${side === "pip" ? "pip" : ""}`;
  n.style.textAlign = side === "pip" ? "right" : "left";
  const who = side === "pip" ? SESSION.pip.address : ((window as any).__sellerAddr ?? SESSION.momo.address);
  const face = `<img src="${blobAvatar(who)}" width="20" height="20" style="vertical-align:-5px;border-radius:50%">`;
  n.innerHTML = side === "pip"
    ? `${agentName("pip")} (buyer) <span style="margin-left:5px">${face}</span>`
    : `<span style="margin-right:5px">${face}</span> ${(window as any).__sellerName ?? agentName("momo")} (seller)`;
  $("chat").appendChild(n);
}
function bubble(side: "pip" | "momo", text: string) {
  ensureName(side);
  const row = document.createElement("div");
  row.className = `row ${side}`;
  row.innerHTML = `<div class="bubble">${text}</div>`;
  $("chat").appendChild(row);
  row.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function sys(text: string, cls = "") {
  const row = document.createElement("div");
  row.className = "row sys";
  row.innerHTML = `<div class="s ${cls}">${text}</div>`;
  $("chat").appendChild(row);
  row.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function typing(side: "pip" | "momo", label: string) {
  ensureName(side);
  const row = document.createElement("div");
  row.className = `row ${side} typing`;
  row.innerHTML = `<div class="bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;
  const lab = document.createElement("div");
  lab.className = `tlabel ${side}`;
  lab.textContent = label;
  $("chat").appendChild(row);
  $("chat").appendChild(lab);
  row.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return () => { row.remove(); lab.remove(); };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const status = (t: string) => (($("status") as HTMLElement).textContent = t);

// agent display names (fixed)
const DEFAULT_NAMES: Record<string, string> = { pip: "Pip", momo: "Momo", kiki: "Kiki" };
function agentName(k: string): string {
  try { return localStorage.getItem("name:" + k) || DEFAULT_NAMES[k]; } catch { return DEFAULT_NAMES[k]; }
}

async function renderFeed() {
  // the market board: every merchant's live quote, terms and track record, plus Pip's own notebook against those terms
  try {
    const mk = await fetch(`/api/market?cfg_momo=${merchantCfg("momo")}&cfg_kiki=${merchantCfg("kiki")}`).then((r) => r.json());
    const ul = document.getElementById("board");
    if (ul) ul.innerHTML = (mk.merchants ?? []).map((m: any) => {
      const mine = myPaidLastHour(m.id);
      return `<li><img src="${blobAvatar(m.address, 16)}" width="16" height="16" style="vertical-align:-3px;border-radius:50%;margin-right:6px"><b>${m.name}</b> quotes ${m.quoteXlm} XLM (${m.rationale}); ${m.trackRecord.payments} payments, ${m.trackRecord.lastHour} in the last hour, ${m.trackRecord.customers} customers; terms: min ${m.terms.minTicketXlm} XLM, max ${m.terms.maxPaymentsPerCustomerPerHour}/customer/hour, Pip ${mine}/${m.terms.maxPaymentsPerCustomerPerHour} this hour</li>`;
    }).join("") || "<li style='color:var(--sub)'>market unavailable</li>";
  } catch { const ul = document.getElementById("board"); if (ul) ul.innerHTML = "<li style='color:var(--sub)'>market unavailable</li>"; }
  for (const mid of ["momo", "kiki"]) {
    try {
      const f = await fetch(`/api/momo/feed?merchant=${mid}`).then((r) => r.json());
      const ul = document.getElementById(`feedlist-${mid}`); if (!ul) continue;
      const rows = (f.customers ?? []).slice(0, 6).map((c: any) => {
        const who = c.address === SESSION.pip.address ? "Pip (this page)" : (c.name ? c.name : "agent " + c.address.slice(0, 6) + "…");
        return `<li><img src="${blobAvatar(c.address, 16)}" width="16" height="16" style="vertical-align:-3px;border-radius:50%;margin-right:6px">${who}: ${c.payments} payment${c.payments === 1 ? "" : "s"}, ${(+c.totalXlm).toFixed(2)} XLM decrypted, last ledger ${c.lastLedger} <a href="https://stellar.expert/explorer/testnet/account/${c.address}" target="_blank" rel="noreferrer">↗</a></li>`;
      });
      ul.innerHTML = rows.join("") + `<li style="color:var(--sub)">${DEFAULT_NAMES[mid]}: ${f.paymentsTotal} payments, ${(+f.receivedXlm).toFixed(2)} XLM received in total</li>`;
    } catch { const ul = document.getElementById(`feedlist-${mid}`); if (ul) ul.innerHTML = "<li style='color:var(--sub)'>feed unavailable</li>"; }
  }
}
renderFeed();

// ── configure the agents: read the panel, persist, and expose cfg for merchant calls ──
const CFG_KEYS = ["pip-budget","pip-style","pip-shop","pip-rounds","pip-proto","pip-every","pip-limits","momo-list","momo-floor","momo-surge","momo-cap","kiki-list","kiki-floor","kiki-surge","kiki-cap"];
const CFG_LABELS: Record<string, string> = { "pip-budget": "Pip budget", "pip-style": "Pip style", "pip-shop": "Pip shopping", "pip-rounds": "Pip rounds", "pip-proto": "Pip protocol", "pip-every": "tick every", "pip-limits": "Pip respects hourly limits", "momo-list": "Momo list", "momo-floor": "Momo floor", "momo-surge": "Momo surge", "momo-cap": "Momo surge cap", "kiki-list": "Kiki list", "kiki-floor": "Kiki floor", "kiki-surge": "Kiki surge", "kiki-cap": "Kiki surge cap" };
const cfgVal = (k: string) => { const el = document.getElementById("c-" + k) as HTMLInputElement | null; return !el ? "" : el.type === "checkbox" ? String(el.checked) : el.value; };
function cfgLoad() {
  try {
    const saved = JSON.parse(localStorage.getItem("agentcfg") || "{}");
    for (const k of CFG_KEYS) { const el = document.getElementById("c-" + k) as HTMLInputElement | null; if (el && saved[k] != null) { if (el.type === "checkbox") el.checked = saved[k] !== "false"; else el.value = saved[k]; } }
  } catch {}
  cfgSync();
}
function cfgSave() {
  const out: any = {};
  for (const k of CFG_KEYS) out[k] = cfgVal(k);
  try { localStorage.setItem("agentcfg", JSON.stringify(out)); } catch {}
  cfgSync();
  if (!clockOn) setClockUi();
}
function cfgSync() {
  const g = (k: string) => (document.getElementById("c-" + k) as HTMLInputElement | null)?.value ?? "";
  const shop = document.getElementById("shop") as HTMLSelectElement | null; if (shop) shop.value = g("pip-shop") || "cheapest";
  const style = document.getElementById("style") as HTMLSelectElement | null; if (style) style.value = g("pip-style") || "haggle";
  const amt = document.getElementById("amt") as HTMLInputElement | null; if (amt && g("pip-budget") !== "") amt.value = g("pip-budget");
}
export function merchantCfg(id: "momo" | "kiki") {
  const g = (k: string) => (document.getElementById(`c-${id}-${k}`) as HTMLInputElement | null)?.value;
  const c = { listXlm: g("list"), floorXlm: g("floor"), surgePerPaymentXlm: g("surge"), surgeCapXlm: g("cap") };
  return btoa(JSON.stringify(c));
}
export function pipProto(): "negotiate" | "mpp" { return ((document.getElementById("c-pip-proto") as HTMLSelectElement | null)?.value === "mpp") ? "mpp" : "negotiate"; }
export function pipEvery() { const v = Number((document.getElementById("c-pip-every") as HTMLSelectElement | null)?.value); return Number.isFinite(v) && v >= 30 ? v : 60; }
/** Pip's notebook: how many times each merchant has served Pip in the last hour, from this browser's own record. */
function myPaidLastHour(mid: string) {
  const cut = Date.now() - 3600_000;
  return loadHistory().filter((r) => (r.mid ?? "momo") === mid && (r.ts ?? Date.parse(r.at.replace(" ", "T") + ":00Z")) > cut).length;
}
export function pipRounds() { const v = Number((document.getElementById("c-pip-rounds") as HTMLInputElement | null)?.value); return Number.isFinite(v) && v >= 1 ? Math.min(6, Math.round(v)) : 3; }
document.addEventListener("DOMContentLoaded", () => {
  cfgLoad();
  setClockUi();
  document.getElementById("cfgpanel")?.addEventListener("input", cfgSave);
  document.getElementById("cfgpanel")?.addEventListener("change", cfgSave);
  document.getElementById("amt")?.addEventListener("input", () => { const b = document.getElementById("c-pip-budget") as HTMLInputElement | null; if (b) { b.value = (document.getElementById("amt") as HTMLInputElement).value; cfgSave(); } });
  document.getElementById("c-reset")?.addEventListener("click", () => { localStorage.removeItem("agentcfg"); location.reload(); });
});

// USD mode: live XLM/USD from the reflector oracle (mainnet, read-only, keyless)
async function xlmUsdRate(sdk: any): Promise<number> {
  const { Contract, TransactionBuilder, Networks, xdr: X, scValToNative, rpc } = sdk;
  const server = new (rpc?.Server ?? sdk.SorobanRpc.Server)("https://mainnet.sorobanrpc.com");
  const source = await server.getAccount("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7");
  const contract = new Contract("CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN");
  const asset = X.ScVal.scvVec([X.ScVal.scvSymbol("Other"), X.ScVal.scvSymbol("XLM")]);
  const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.PUBLIC })
    .addOperation(contract.call("lastprice", asset)).setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  const native = scValToNative(sim.result.retval);
  const rate = Number(native.price) / 1e14;
  if (!(rate > 0.01 && rate < 100)) throw new Error("oracle rate out of sane range");
  return rate;
}

// ── the run ─────────────────────────────────────────────────────────────────
let running = false;
async function run(tick = 0, afterHeader?: () => void) {
  if (running) return;
  running = true;
  const btn = $("run") as HTMLButtonElement;
  btn.disabled = true;
  if (tick) {
    const chat = $("chat");
    chat.querySelector(".empty")?.remove();
    while (chat.children.length > 160) chat.firstElementChild?.remove();
    sys(`round ${tick}, ${new Date().toISOString().slice(11, 19)} UTC`, "tick");
    afterHeader?.();
  } else { $("chat").innerHTML = ""; }
  lastSide = "";
  $("slip").classList.remove("printed");
  const mask0 = document.getElementById("feedmask") as HTMLElement | null; if (mask0) { mask0.style.height = "0px"; mask0.classList.remove("printing"); }
  ($("exports") as HTMLElement).style.visibility = "hidden";

  try {
    // The run emits ~80 narration lines; the stage strip is the spine that tells
// you WHERE you are while they stream past. Cheap, and reset per run.
const STAGES = ["shop", "deal", "prove", "settle", "deliver"] as const;
function stage(name: (typeof STAGES)[number] | null) {
  const els = document.querySelectorAll<HTMLElement>(".stages li");
  if (!name) {
    for (const el of els) { el.removeAttribute("data-on"); el.removeAttribute("data-done"); }
    return;
  }
  const at = STAGES.indexOf(name);
  for (const el of els) {
    const i = STAGES.indexOf((el.dataset.stage ?? "") as (typeof STAGES)[number]);
    el.removeAttribute("data-on"); el.removeAttribute("data-done");
    if (i < at) el.setAttribute("data-done", "1");
    else if (i === at) el.setAttribute("data-on", "1");
  }
}
function stagesDone() {
  for (const el of document.querySelectorAll<HTMLElement>(".stages li")) {
    el.removeAttribute("data-on"); el.setAttribute("data-done", "1");
  }
}
    status("loading client…");
    const [{ Keypair, Address, nativeToScVal, xdr }, core, chain, circuit] = await Promise.all([
      import("@stellar/stellar-sdk"),
      import("stellar-confidential-token-sdk"),
      import("stellar-confidential-token-sdk/chain"),
      fetch("/circuits/transfer.json").then((r) => r.json()),
    ]);
    const { deriveSk, deriveKeys, skSigningMessage, addressToField, StateEngine, pointToBytes,
            proverFromArtifact, buildTransferWitness, encodeTransferData } = core as any;
    const { ChainClient, keypairSigner, hybridFetchEvents } = chain as any;
    const addr = (a: string) => new Address(a).toScVal();
    const i128 = (v: bigint) => nativeToScVal(v, { type: "i128" });
    const bytesVal = (b: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(b));

    const client = new ChainClient({ rpcUrl: RPC, networkPassphrase: PASSPHRASE, contracts: SESSION.contracts });
    const pipKp = Keypair.fromSecret(SESSION.pip.secret);
    const momoKp = Keypair.fromSecret(SESSION.momo.secret);
    const ident = (kp: any) => {
      const message = skSigningMessage(SESSION.contracts.token, kp.publicKey());
      const root = new Uint8Array(kp.signMessage(Buffer.from(message)));
      const { sk, addrF } = deriveSk(root, SESSION.contracts.token, kp.publicKey());
      return { keys: deriveKeys(sk, addrF, addressToField(kp.publicKey())), address: kp.publicKey() };
    };
    const pip = ident(pipKp);
    void momoKp;
    const pipSigner = keypairSigner(pipKp.secret(), PASSPHRASE);

    const mine = (address: string, events: any[]) => events.filter((ev) =>
      ev.type === "register" || ev.type === "merge" ? ev.account === address : ev.from === address || ev.to === address);
    // replay from the latest checkpoint when one exists (defuses the RPC retention window), else from genesis
    let CP: any = null;
    try { CP = await fetch("/checkpoint.json", { cache: "no-store" }).then((r) => r.ok ? r.json() : null); } catch {}
    const { reviveState } = core as any;
    const cpFor = (address: string) => {
      const entry: any = CP?.agents ? Object.values(CP.agents).find((a: any) => a?.address === address) : null;
      return entry?.state ? { state: reviveState(entry.state), savedAtLedger: entry.savedAtLedger as number } : null;
    };
    const rebuild = async (who: { address: string; keys: any }) => {
      const cp = cpFor(who.address);
      const from = cp ? Math.max(SESSION.fromLedger, cp.savedAtLedger - 50) : SESSION.fromLedger;
      const { events } = await hybridFetchEvents(client, undefined, { fromLedger: from });
      const e = new StateEngine({ address: who.address, keys: who.keys, store: cp ? { load: async () => cp.state, save: async () => {} } : undefined });
      if (cp) await e.load();
      const evs = mine(who.address, events).filter((ev: any) => !cp || ev.ledger > cp.state.lastLedger);
      e.ingestEvents(evs);
      return e;
    };

    // ── Pip's policy: a budget it will not exceed, and a haggling style ──
    const parseXlm = (raw: string): bigint | null => {
      const t = raw.trim();
      if (!t) return null;
      if (!/^\d+(\.\d{1,7})?$/.test(t)) throw new Error("budget must be a number with up to 7 decimals, e.g. 3.7");
      const [i, f = ""] = t.split(".");
      const v = BigInt(i) * STROOP + BigInt((f + "0000000").slice(0, 7));
      if (v <= 0n) throw new Error("budget must be positive");
      if (v > 200n * STROOP) throw new Error("keep the budget under 200 XLM, it's a shared testnet balance");
      return v;
    };
    const denom = ($("denom") as HTMLSelectElement).value;
    const typed = parseXlm(($("amt") as HTMLInputElement).value);
    let budget: bigint;
    if (denom === "usd" && typed) {
      status("reading oracle rate");
      const rate = await xlmUsdRate(await import("@stellar/stellar-sdk"));
      const usd = Number(typed) / 1e7;
      budget = BigInt(Math.round((usd / rate) * 1e7));
      if (budget > 200n * STROOP) throw new Error(`$${usd} is ${(Number(budget) / 1e7).toFixed(2)} XLM at the current rate; keep it under 200 XLM`);
      sys(`Pip's budget: $${usd} = ${(Number(budget) / 1e7).toFixed(4)} XLM at ${rate.toFixed(4)} USD/XLM (live reflector oracle). The merchant will not learn this number.`);
    } else {
      budget = typed ?? BigInt(3 + Math.floor(Math.random() * 5)) * STROOP;
      sys(`Pip's budget: ${(Number(budget) / 1e7)} XLM (private to Pip). Merchants quote from their own policies; neither side knows the other's number.`);
    }
    const style = (($("style") as HTMLSelectElement | null)?.value ?? "haggle") as "haggle" | "take" | "stingy";

    // ── Pip shops: reads the market, picks a merchant by its own shopping policy ──
    stage(null); stage("shop"); status("Pip reads the market");
    let chosen: any = null;
    try {
      const mk = await fetch(`/api/market?cfg_momo=${merchantCfg("momo")}&cfg_kiki=${merchantCfg("kiki")}`).then((r) => r.json());
      const all: any[] = mk.merchants ?? [];
      sys(`market: ${all.map((r) => `${r.name} ${r.quoteXlm} XLM (${r.trackRecord.payments} payments, ${r.trackRecord.customers} customers, min ticket ${r.terms.minTicketXlm}, max ${r.terms.maxPaymentsPerCustomerPerHour}/hour)`).join(", ")}`);
      // Pip holds itself to the terms it read: a merchant that has served it the hourly maximum is off the list this tick
      const respect = (document.getElementById("c-pip-limits") as HTMLInputElement | null)?.checked ?? true;
      const capped = respect ? all.filter((r) => myPaidLastHour(r.id) >= r.terms.maxPaymentsPerCustomerPerHour) : [];
      if (!respect) { const over = all.filter((r) => myPaidLastHour(r.id) >= r.terms.maxPaymentsPerCustomerPerHour); if (over.length) sys(`as you asked, Pip ignores its notebook this round (${over.map((r) => `${r.name} ${myPaidLastHour(r.id)}/${r.terms.maxPaymentsPerCustomerPerHour}`).join(", ")}). Expect the till to decline and the refund path to run.`); }
      const rows = all.filter((r) => !capped.includes(r));
      if (capped.length) sys(`Pip's notebook: ${capped.map((r) => `${r.name} has served Pip ${myPaidLastHour(r.id)} of ${r.terms.maxPaymentsPerCustomerPerHour} this hour`).join("; ")}. Pip will not pay a shop past the terms it read.`);
      if (!rows.length) {
        sys(`every merchant has served Pip its hourly maximum. Paying again would be declined at the till and refunded, so Pip sits this round out until the hour rolls.`);
        stage(null); status("sitting out"); return;
      }
      const shopPolicy = (($("shop") as HTMLSelectElement | null)?.value ?? "cheapest") as "cheapest" | "trusted" | "momo" | "kiki";
      const trusted = rows.filter((r) => r.trackRecord.payments >= 3);
      if (shopPolicy === "momo" || shopPolicy === "kiki") chosen = rows.find((r) => r.id === shopPolicy) ?? rows[0];
      else if (shopPolicy === "trusted") chosen = (trusted.length ? trusted : rows).sort((a, b) => b.trackRecord.payments - a.trackRecord.payments)[0];
      else chosen = [...rows].sort((a, b) => a.quoteXlm - b.quoteXlm)[0];
      sys(`Pip's shopping policy "${shopPolicy}" picks ${chosen.name}: ${chosen.rationale}${(shopPolicy === "momo" || shopPolicy === "kiki") && chosen.id !== shopPolicy ? ` (${shopPolicy} is capped for Pip this hour)` : ""}`);
    } catch { chosen = { id: "momo", name: "Momo" }; sys("market unavailable, defaulting to Momo"); }
    const MID = chosen.id as string;
    const SELLER = MID === "kiki" ? (SESSION as any).kiki : SESSION.momo;
    (window as any).__sellerName = chosen.name;
    (window as any).__sellerAddr = SELLER.address;
    const sellerKp = Keypair.fromSecret(SELLER.secret);
    const seller = ident(sellerKp);
    const proto = pipProto();

    // ── Pip reads the chosen merchant's signed terms before doing business ──
    status(`Pip reads ${chosen.name}'s terms`);
    let terms: any = null;
    try {
      terms = await fetch(`/api/momo/terms?merchant=${MID}&cfg=${merchantCfg(MID as any)}`).then((r) => r.json());
      const tOk = sellerKp.verify((await import("@stellar/stellar-sdk")).hash(Buffer.from(JSON.stringify({ seller: terms.seller, terms: terms.terms, issuedAt: terms.issuedAt }))), Buffer.from(terms.signature, "base64"));
      sys(`Pip fetched ${chosen.name}'s terms v${terms.terms.version} (signed by ${chosen.name}, signature ${tOk ? "verified" : "FAILED"}): min ticket ${terms.terms.minTicketXlm} XLM, max ${terms.terms.maxPaymentsPerCustomerPerHour} payments/customer/hour, ${terms.terms.blocklist.length} blocked counterparty. ${chosen.name} is examinable by auditor #${terms.terms.auditorId}, by protocol.`);
    } catch { sys(`could not fetch ${chosen.name}'s terms; proceeding without them`); }

    const xl = (v: bigint) => (Number(v) / 1e7).toString();
    let agreed: bigint | null = null;
    let invoiceDoc: any = null;
    let challenge: any = null;   // MPP: the 402 challenge Pip is paying
    let t = () => {};
    const mppUrl = `/api/mpp/brief?merchant=${MID}&cfg=${merchantCfg(MID as any)}`;
    if (proto === "mpp") {
      // ── Machine Payments Protocol: Pip asks for the resource and gets a 402 challenge. Take it or leave it. ──
      status(`Pip requests the brief over MPP from ${chosen.name}`);
      bubble("pip", `GET /api/mpp/brief. Send me the challenge.`);
      t = typing("momo", `${chosen.name} prices from its books and issues an MPP challenge`);
      const r1 = await fetch(mppUrl);
      t();
      if (r1.status !== 402) throw new Error(`expected 402 Payment Required from ${chosen.name}, got ${r1.status}`);
      const { Challenge } = await import("mppx");
      challenge = Challenge.fromHeaders(r1.headers);
      const amt = BigInt(challenge.request.amount);
      let exp = ""; try { if (challenge.expires) { const d = new Date(challenge.expires); if (!isNaN(d.getTime())) exp = d.toISOString().slice(11, 19) + " UTC"; } } catch {}
      bubble("momo", `402 Payment Required. ${xl(amt)} XLM, method stellar, intent confidential-charge. Pay it confidentially and present the credential.`);
      sys(`WWW-Authenticate: Payment id ${String(challenge.id).slice(0, 10)}…, method "stellar", intent "confidential-charge", amount ${amt} stroops, recipient ${String(challenge.request.recipient).slice(0, 6)}…, settlement confidential${exp ? ", expires " + exp : ""}. The challenge is HMAC-bound by ${chosen.name}. MPP has no haggling: Pip pays this amount or walks.`);
      await wait(400);
      if (amt > budget) {
        bubble("pip", `${xl(amt)} is over my budget. Leaving it.`);
        sys(`no deal: the MPP challenge (${xl(amt)} XLM) is above Pip's budget (${xl(budget)} XLM). Nothing was paid, nothing hit the chain. Raise the budget or switch Pip to "negotiate", where it can counter.`);
        stage(null); status("no deal"); return;
      }
      agreed = amt;
      bubble("pip", `${xl(amt)} works. Paying the challenge confidentially.`);
    } else {
    // ── Momo is a real service. Pip asks it for a quote. ──
    status(`Pip requests a quote from ${chosen.name}`);
    bubble("pip", "Need the settlement brief. What's your price today?");
    t = typing("momo", `${chosen.name} checks its books`);
    const q1 = await fetch("/api/momo/quote", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ buyer: pip.address, merchant: MID, cfg: merchantCfg(MID as any) }) }).then((r) => r.json());
    t();
    if (!q1?.priceXlm) throw new Error(`${chosen.name} did not answer`);
    bubble("momo", `${q1.priceXlm} XLM. ${q1.rationale}. Pay confidentially; the amount stays between us and the auditor.`);
    sys(`${chosen.name}'s quote is signed by ${chosen.name} (${String(q1.signature).slice(0, 10)}…) and reflects its books: ${q1.booksHint?.paymentsEverReceived} payments ever, ${q1.booksHint?.lastHour} in the last hour`);

    // ── Pip decides: accept, counter, or walk ──
    const quoted = BigInt(Math.round(q1.priceXlm * 1e7));
    await wait(500);
    if (quoted <= budget && style === "take") {
      agreed = quoted; bubble("pip", `${xl(quoted)} works. Paying now.`);
      const qa = await fetch("/api/momo/quote", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ buyer: pip.address, accept: true, merchant: MID, cfg: merchantCfg(MID as any) }) }).then((r) => r.json());
      invoiceDoc = qa.invoice ?? null;
    } else {
      // counter: haggle opens at ~60% of the quote (capped at budget); stingy opens at 40%
      const openFrac = style === "stingy" ? 0.4 : 0.6;
      let offer = BigInt(Math.round(Number(quoted) * openFrac));
      if (offer > budget) offer = budget;
      for (let round = 0; round < pipRounds() && agreed === null; round++) {
        bubble("pip", round === 0 ? `Steep. I can do ${xl(offer)}.` : `Meet me at ${xl(offer)}?`);
        t = typing("momo", "considering the offer");
        const q2 = await fetch("/api/momo/quote", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ buyer: pip.address, offer: Number(offer) / 1e7, merchant: MID, cfg: merchantCfg(MID as any) }) }).then((r) => r.json());
        t();
        if (q2.accepted) { agreed = offer; invoiceDoc = q2.invoice ?? null; bubble("momo", `${q2.note}. ${xl(offer)} it is.`); break; }
        bubble("momo", `${q2.note}.`);
        // raise toward the quote, never past the budget
        const next = offer + (quoted - offer) / 2n;
        if (next > budget || next <= offer) {
          if (quoted <= budget) {
            agreed = quoted; bubble("pip", `Fine, ${xl(quoted)}. Paying.`);
            const qa = await fetch("/api/momo/quote", { method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ buyer: pip.address, accept: true, merchant: MID, cfg: merchantCfg(MID as any) }) }).then((r) => r.json());
            invoiceDoc = qa.invoice ?? null;
          }
          else { bubble("pip", `That's over my budget. Walking away.`); }
          break;
        }
        offer = next;
      }
    }
    } // end negotiate
    if (agreed === null) {
      sys(`no deal: ${chosen.name}'s floor is above Pip's budget. Nothing was paid, nothing hit the chain. Raise the budget or change Pip's style.`);
      status("no deal");
      return;
    }
    const price = agreed;
    const priceXlm = xl(price);
    if (invoiceDoc?.invoiceId) sys(`${chosen.name} issued invoice ${String(invoiceDoc.invoiceId).slice(0, 12)}… for ${priceXlm} XLM to Pip (signed, expires in 10 min). Pip will bind the payment to it by attesting {invoiceId, tx} with its own key.`);
    if (terms && Number(priceXlm) < terms.terms.minTicketXlm) {
      sys(`Pip: agreed price ${priceXlm} XLM is under ${chosen.name}'s minimum ticket ${terms.terms.minTicketXlm} XLM per its own terms; paying would be refused at the till. Walking.`);
      stage(null); status("no deal (terms)"); return;
    }

    // ── funds check + top-up if needed (real transactions, no proof required) ──
    stage("deal"); status("checking balance…");
    let pipEngine = await rebuild(pip);
    let spendable = pipEngine.state().spendable;
    if (spendable.v < price + 2n * STROOP) {
      const topup = price + 100n * STROOP;
      sys(`buyer balance low, depositing ${xl(topup)} XLM into the contract (deposits are public by design)`);
      const dep = await client.invoke(SESSION.contracts.token, "deposit",
        [addr(pip.address), addr(pip.address), i128(topup)], pipSigner);
      sys(`deposit tx ${dep.hash.slice(0, 10)}…`);
      const mrg = await client.invoke(SESSION.contracts.token, "merge", [addr(pip.address)], pipSigner);
      sys(`merge tx ${mrg.hash.slice(0, 10)}…`);
      pipEngine = await rebuild(pip);
      spendable = pipEngine.state().spendable;
    }

    // ── Pip pays: proof in this tab, settle on testnet ──
    t = typing("pip", "generating zero-knowledge proof in this tab…");
    stage("prove"); status("proving…");
    const kAud = await client.auditorKey(SESSION.auditorId);
    const t0 = performance.now();
    const witness = buildTransferWitness({
      keys: pip.keys, v: spendable.v, r: spendable.r, amount: price,
      pvkB: seller.keys.PVK, kAudR: kAud, kAudS: kAud,
    });
    const prover = proverFromArtifact(circuit);
    const { proof } = await prover.prove(witness.inputs);
    await prover.destroy();
    const proveSecs = ((performance.now() - t0) / 1000).toFixed(1);
    const payload = new Uint8Array(encodeTransferData(witness, proof).bytes());
    const rEScalarForDisclosure: bigint = witness.rEScalar;
    t();
    sys(`proof generated in this browser in ${proveSecs}s`, "good");

    t = typing("pip", "submitting to testnet…");
    stage("settle"); status("submitting…");
    const pay = await client.invoke(SESSION.contracts.token, "confidential_transfer",
      [addr(pip.address), addr(seller.address), bytesVal(payload)], pipSigner);
    t();
    sys(`confidential transfer settled <a href="https://stellar.expert/explorer/testnet/tx/${pay.hash}" target="_blank" rel="noreferrer">${pay.hash.slice(0, 16)}…</a> (the amount is not in that transaction)`, "good");
    bubble("pip", `Sent. ${xl(price)} as agreed. Check your side.`);

    // ── Momo checks the till: decrypts THIS payment with its own key, server-side ──
    await wait(400);
    t = typing("momo", `${chosen.name} checks the till, decrypting your transfer with its key`);
    status(`${chosen.name} verifying by decryption…`);
    let served: any = null;
    let mppReceipt: string | null = null;
    if (challenge) {
      // MPP credential: signedHash, sourceSignature = Pip's Ed25519 signature over "{challenge.id}:{hash}"
      const { Credential } = await import("mppx");
      const sourceSignature = Buffer.from(pipKp.sign(Buffer.from(`${challenge.id}:${pay.hash}`))).toString("hex");
      const credential = Credential.from({ challenge, payload: { type: "signedHash", hash: pay.hash, sourceSignature }, source: pip.address } as any);
      const header = Credential.serialize(credential);
      sys(`Pip presents the credential: Authorization: ${header.slice(0, 28)}… (type signedHash, bound to this challenge, this tx and this payer)`);
      let r2: Response | null = null, body = "";
      for (let attempt = 0; attempt < 8; attempt++) {
        r2 = await fetch(mppUrl, { headers: { Authorization: header } });
        body = await r2.text();
        if (r2.status === 200) break;
        let detail = ""; try { detail = JSON.parse(body)?.detail ?? ""; } catch {}
        if (/policy at the till|does not verify|wrong token|not to this merchant/.test(detail)) { body = detail; break; }
        await wait(2500);
      }
      if (r2?.status !== 200) {
        let detail = body; try { detail = JSON.parse(body)?.detail ?? body; } catch {}
        t();
        if (/policy at the till/.test(detail)) {
          sys(`${chosen.name} re-challenged (402): ${detail.replace(/[<>&]/g, "")}`);
          const rf = await fetch("/api/momo/refund", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: pay.hash, merchant: MID }) }).then((r) => r.json()).catch(() => null);
          sys(rf?.queued || rf?.refunded ? `Pip asked for its money back; ${chosen.name}'s worker refunds it by confidential_transfer (${rf.refundTx ? "done, tx " + String(rf.refundTx).slice(0, 12) + "…" : "queued, see /refunds.json"})` : `refund request: ${String(rf?.error ?? "no answer").replace(/[<>&]/g, "")}`);
        }
        throw new Error(`MPP verification did not succeed: ${detail}`);
      }
      served = JSON.parse(body);
      mppReceipt = r2.headers.get("payment-receipt");
      served.delivered = true;
      served.binding = { ok: true, mpp: true };
      t();
      let rj: any = null; try { rj = JSON.parse(atob(mppReceipt ?? "")); } catch {}
      sys(`200 OK with Payment-Receipt: ${mppReceipt ? mppReceipt.slice(0, 22) + "…" : "(none)"}${rj ? ` = { method ${rj.method}, reference ${String(rj.reference).slice(0, 10)}…, status ${rj.status} }` : ""}. ${chosen.name} verified the credential by decrypting the transfer with its own key and applied its terms at the till.`, "good");
    } else
    for (let attempt = 0; attempt < 6 && !served?.delivered; attempt++) {
      // Pip attests {invoiceId, tx} with the same key that paid: binds this payer + this payment + this invoice
      const attest = invoiceDoc ? pipKp.sign((await import("@stellar/stellar-sdk")).hash(Buffer.from(JSON.stringify({ invoiceId: invoiceDoc.invoiceId, tx: pay.hash })))).toString("base64") : null;
      if (!invoiceDoc) throw new Error("no invoice was issued for this deal; refusing to pay unbound");
      const invParam = `&invoice=${encodeURIComponent(btoa(JSON.stringify({ invoice: invoiceDoc.invoice, signature: invoiceDoc.signature, attest })))}`;
      const resp = await fetch(`/api/momo/pay?tx=${pay.hash}&agreed=${priceXlm}&name=Pip&merchant=${MID}&cfg=${merchantCfg(MID as any)}${invParam}`);
      served = await resp.json().catch(() => null);
      if (served?.delivered) break;
      if (served?.paid && served?.decryptedXlm != null && !served?.delivered) break; // mismatch, no retry
      await wait(2500);
    }
    if (!challenge) t();
    if (!served?.paid) throw new Error(served?.error || `${chosen.name} could not find the payment`);
    if (!served.delivered) {
      if (served.policy) {
        sys(`policy at the till: ${served.policy.rule}: ${served.policy.reason} (terms v${served.policy.terms}). Payment decrypted as ${served.decryptedXlm} XLM and held, refundable.`);
        const rf = await fetch("/api/momo/refund", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: pay.hash, merchant: MID }) }).then((r) => r.json()).catch(() => null);
        sys(rf?.queued || rf?.refunded ? `Pip asked for its money back; ${chosen.name}'s worker refunds it by confidential_transfer (${rf.refundTx ? "done, tx " + String(rf.refundTx).slice(0, 12) + "…" : "queued, see /refunds.json"})` : `refund request: ${String(rf?.error ?? "no answer").replace(/[<>&]/g, "")}`);
      }
      throw new Error(served.error || `${chosen.name} refused delivery`);
    }
    if (served.policy?.allow) sys(`policy at the till passed (terms v${served.policy.terms}): min ticket, velocity, blocklist all clear`);
    if (served.binding?.ok && !served.binding.mpp) sys(`invoice binding verified: Pip attested {invoice ${String(served.binding.invoiceId).slice(0, 12)}…, tx} with its own key, invoice issued to Pip for exactly this amount, redeemed once. Replaying this tx against another request will fail.`, "good");
    const momoAfter = BigInt(Math.round((served.decryptedXlm ?? Number(priceXlm)) * 1e7));
    bubble("momo", served.decryptedXlm != null ? `Confirmed. I decrypted exactly ${served.decryptedXlm} XLM from your transfer. Matches what we agreed. Shipping.` : `Confirmed by decryption. Shipping.`);
    const sigOk = sellerKp.verify(
      (await import("@stellar/stellar-sdk")).hash(Buffer.from(JSON.stringify(served.brief))),
      Buffer.from(served.signature, "base64"));
    sys(`${chosen.name} verified the payment by decrypting it (not by trusting Pip), delivered "${served.brief.title}", sha256 ${String(served.sha256).slice(0, 12)}…, signature ${sigOk ? "verified" : "FAILED"}`, sigOk ? "good" : "");
    stage("deliver");
    bubble("momo", `Delivered: "${served.brief.title}".`);

    // chain verification of the buyer's own state
    const after = await rebuild(pip);
    const onchain = await client.confidentialBalance(pip.address);
    const check = after.verifyAgainstChain({
      spendableC: pointToBytes(onchain.spendableBalance),
      receivingC: pointToBytes(onchain.receivingBalance),
    });
    if (check.ok) stagesDone();
    sys(check.ok ? "buyer state verified byte-for-byte against on-chain commitments" : "verify mismatch", check.ok ? "good" : "");
    await wait(300);
    bubble("pip", "Received. Good doing business.");

    // ── Selective disclosure: an examiner shows up. Pip proves THIS payment to them, and only this. ──
    if ((($("disclose") as HTMLInputElement | null)?.checked ?? true)) {
      status("examiner requests disclosure…");
      sys("an examiner appears (fresh keys, no wallet secrets, could be an accountant or regulator). It asks Pip to disclose this one payment.");
      t = typing("pip", "proving the amount of this exact transfer to the examiner (zero-knowledge, sender-role)");
      try {
        // Pip needs the on-chain event for its own transfer
        const { events: evs } = await hybridFetchEvents(client, undefined, { fromLedger: SESSION.fromLedger });
        const myEv: any = evs.find((e: any) => e.type === "transfer" && String(e.txHash).toLowerCase() === pay.hash.toLowerCase());
        if (!myEv) throw new Error("own transfer event not found yet");
        const [dc, dvk] = await Promise.all([
          fetch("/circuits/disclose_sender.json").then((r) => r.json()),
          fetch("/circuits/disclose_sender.vk.json").then((r) => r.json()),
        ]);
        const d = await discloseToExaminer({
          core, client, circuit: dc, vkBase64: dvk.vkBase64, role: "sender", keys: pip.keys, rEScalar: rEScalarForDisclosure,
          pvkB: seller.keys.PVK, event: myEv, addrF: addressToField(SESSION.contracts.token), disclosingAccount: pip.address,
        });
        t();
        sys(`examiner verified with no keys of its own: this transfer was exactly ${d.amountXlm} XLM (proof ${d.proveSecs}s, verify ${d.verifySecs}s, ${d.steps.length} checks, pinned OpenZeppelin vk). It learned nothing else: not Pip's balance, not other payments, not Momo's side.`, d.ok ? "good" : "");
        bubble("pip", `Disclosed to the examiner: ${d.amountXlm} XLM for this payment. That's all they get.`);
        (window as any).__lastDisclosure = d.bundle;
      } catch (e: any) {
        t();
        sys(`disclosure skipped: ${String(e?.message ?? e).replace(/[<>&]/g, "")}`);
      }
    }
    status("");

    // the receipt, with the actual fee charged
    let feeXlm = "";
    try {
      const tr = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: { hash: pay.hash } }) }).then((r) => r.json());
      const fc = xdr.TransactionResult.fromXDR(tr.result.resultXdr, "base64").feeCharged().toString();
      feeXlm = (Number(fc) / 1e7).toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
    } catch {}
    receipt(pay.hash, priceXlm, (Number(after.state().spendable.v) / 1e7).toString(), feeXlm, { name: chosen.name, address: SELLER.address },
      challenge ? `MPP stellar/confidential-charge, Payment-Receipt ${String(mppReceipt ?? "").slice(0, 14)}…` : `quote, negotiated, invoice ${String(invoiceDoc?.invoiceId ?? "").slice(0, 10)}… payer-attested`);

    // live panels: chain view vs decrypted view + history
    try {
      $("seller-who").textContent = `${chosen.name}, seller`;
      const vegaOn = await client.confidentialBalance(seller.address);
      $("pip-commit").textContent = Buffer.from(pointToBytes(onchain.spendableBalance)).toString("hex").slice(0, 48) + "…";
      $("momo-commit").textContent = Buffer.from(pointToBytes(vegaOn.receivingBalance)).toString("hex").slice(0, 48) + "…";
      $("pip-dec").textContent = (Number(after.state().spendable.v) / 1e7).toString() + " XLM spendable";
      $("momo-dec").textContent = (Number(momoAfter) / 1e7).toString() + " XLM decrypted from this payment";
      ($("balances") as HTMLElement).style.display = "";
    } catch {}
    pushHistory({ tx: pay.hash, amt: priceXlm, at: new Date().toISOString().slice(0, 16).replace("T", " "), ts: Date.now(), mid: MID, proto });
    renderFeed();
  } catch (e: any) {
    const raw = String(e?.message || e?.name || e || "unknown");
    if (raw.includes("dynamically imported module")) {
      sys("the site was updated while this tab was open; reloading the new version");
      setTimeout(() => window.location.reload(), 1200);
      return;
    }
    const msg = raw.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
    sys(`error: ${msg}. If two people run this at once the balance state races; try again`, "");
    status("");
  } finally {
    btn.disabled = false;
    running = false;
  }
}

// ── receipt ─────────────────────────────────────────────────────────────────
let lastTx = "";
let lastTxt = "";
function receipt(tx: string, priceXlm: string, changeXlm: string, feeXlm = "", seller = { name: agentName("momo"), address: SESSION.momo.address }, via = "") {
  lastTx = tx;
  const dt = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  $("slip").innerHTML = `
    <div class="t1">PAYMENT RECEIPT</div>
    <div class="t2">stellar testnet, confidential transfer</div>
    <hr class="cut">
    <div class="lr"><span class="l">DATE</span><span class="r">${dt}</span></div>
    <div class="lr"><span class="l">FROM</span><span class="r">${agentName("pip")} <a href="https://stellar.expert/explorer/testnet/account/${SESSION.pip.address}" target="_blank" rel="noreferrer">${SESSION.pip.address.slice(0, 6)}…${SESSION.pip.address.slice(-4)}</a></span></div>
    <div class="lr"><span class="l">TO</span><span class="r">${seller.name} <a href="https://stellar.expert/explorer/testnet/account/${seller.address}" target="_blank" rel="noreferrer">${seller.address.slice(0, 6)}…${seller.address.slice(-4)}</a></span></div>
    <hr class="cut">
    <div class="bigrow"><span>AMOUNT ON-CHAIN</span><span class="amt">ENCRYPTED</span></div>
    <div class="decr">SELLER DECRYPTED: +${priceXlm} XLM (exact match)<br>BUYER CHANGE: ${changeXlm} XLM, chain-verified</div>
    <div class="lr"><span class="l">AUDITOR</span><span class="r">#${SESSION.auditorId}, can decrypt, enforced by the proof</span></div>
    <div class="lr"><span class="l">FEE</span><span class="r">${feeXlm ? feeXlm + " XLM (actual)" : "unavailable"}</span></div>
    <hr class="cut">
    <div class="lr"><span class="l">TX</span><span class="r"><a href="https://stellar.expert/explorer/testnet/tx/${tx}" target="_blank" rel="noreferrer">${tx}</a></span></div>
    <div class="lr"><span class="l">CONTRACT</span><span class="r"><a href="https://stellar.expert/explorer/testnet/contract/${SESSION.contracts.token}" target="_blank" rel="noreferrer">${SESSION.contracts.token.slice(0, 10)}…</a> (OpenZeppelin)</span></div>
    <div class="lr"><span class="l">PROOF</span><span class="r">UltraHonk, generated in this browser</span></div>${via ? `
    <div class="lr"><span class="l">PAID VIA</span><span class="r">${via}</span></div>` : ""}`;
  const slip = $("slip");
  slip.classList.add("printed");
  const slot = document.getElementById("slot");
  if (slot) slot.style.display = "";
  const mask = document.getElementById("feedmask") as HTMLElement | null;
  if (mask) {
    mask.classList.remove("printing");
    mask.style.height = slip.scrollHeight + 16 + "px";
    if (slot) slot.scrollIntoView({ behavior: "smooth", block: "center" });
    void mask.offsetWidth;
    requestAnimationFrame(() => requestAnimationFrame(() => mask.classList.add("printing")));
  }
  ($("exports") as HTMLElement).style.visibility = "visible";
  ($("b-tx") as HTMLAnchorElement).href = `https://stellar.expert/explorer/testnet/tx/${tx}`;
  lastTxt = `PAYMENT RECEIPT - stellar testnet, confidential transfer
${dt}
FROM ${agentName("pip")} ${SESSION.pip.address}
TO   ${seller.name} ${seller.address}${via ? "\nPAID VIA " + via : ""}
AMOUNT ON-CHAIN: ENCRYPTED
seller decrypted: +${priceXlm} XLM (exact match)
buyer change: ${changeXlm} XLM, chain-verified
auditor #${SESSION.auditorId}: can decrypt, enforced by the proof
TX ${tx}
CONTRACT ${SESSION.contracts.token}
`;
  $("slip").scrollIntoView({ behavior: "smooth", block: "center" });
}

type Run = { tx: string; amt: string; at: string; ts?: number; mid?: string; proto?: string };
function loadHistory(): Run[] { try { return JSON.parse(localStorage.getItem("runs") ?? "[]"); } catch { return []; } }
let historyExpanded = false;
function renderHistory() {
  const runs = loadHistory();
  if (!runs.length) return;
  ($("histwrap") as HTMLElement).style.display = "";
  const shown = historyExpanded ? runs : runs.slice(0, 3);
  const row = (r: Run) =>
    `<li>${r.at} UTC, ${r.amt} XLM (hidden on-chain) to ${DEFAULT_NAMES[r.mid ?? "momo"] ?? r.mid}${r.proto === "mpp" ? " over MPP" : ""}, <a href="https://stellar.expert/explorer/testnet/tx/${r.tx}" target="_blank" rel="noreferrer">${r.tx.slice(0, 12)}…</a></li>`;
  const toggle = runs.length > 3
    ? `<li><button class="histmore" id="histmore">${historyExpanded ? "show fewer" : `show all ${runs.length}`}</button></li>`
    : "";
  $("history").innerHTML = shown.map(row).join("") + toggle;
  document.getElementById("histmore")?.addEventListener("click", () => { historyExpanded = !historyExpanded; renderHistory();
 });
}
function pushHistory(r: Run) {
  const runs = [r, ...loadHistory()].slice(0, 40);
  localStorage.setItem("runs", JSON.stringify(runs));
  renderHistory();
}
renderHistory();
// identity strip
function renderIdentity() {
  const strip = document.getElementById("idstrip");
  if (!strip) return;
  const card = (addr: string, key: string, role: string) => `
    <div class="idcard"><img src="${blobAvatar(addr, 40)}" width="40" height="40" alt="">
      <div><div class="idname" data-agent="${key}">${agentName(key)}</div><div class="idrole">${role}</div>
      <a class="idaddr" href="https://stellar.expert/explorer/testnet/account/${addr}" target="_blank" rel="noreferrer">${addr.slice(0, 6)}…${addr.slice(-4)}</a></div></div>`;
  strip.innerHTML = card(SESSION.pip.address, "pip", "buyer, shops the market, pays confidentially") +
    card(SESSION.momo.address, "momo", "merchant, list 5, surge pricing, haggles") +
    card((SESSION as any).kiki?.address ?? "", "kiki", "merchant, list 4, firm floor, stricter terms");
}
renderIdentity();
const ln = $("l-pip") as HTMLAnchorElement, lv = $("l-momo") as HTMLAnchorElement;
ln.href = `https://stellar.expert/explorer/testnet/account/${SESSION.pip.address}`;
ln.textContent = SESSION.pip.address;
lv.href = `https://stellar.expert/explorer/testnet/account/${SESSION.momo.address}`;
lv.textContent = SESSION.momo.address;

$("run").addEventListener("click", () => run());

// ── the clock: Pip acts on its own schedule while this tab is open. Directives are read at the start of every tick. ──
let clockOn = false, tickN = 0, skipNext = false, wakeNow = false;
let lastSnap: Record<string, string> | null = null;
function snapshotCfg() { const o: Record<string, string> = {}; for (const k of CFG_KEYS) o[k] = cfgVal(k); o["pip-budget-live"] = ($("amt") as HTMLInputElement).value; o["denom"] = ($("denom") as HTMLSelectElement).value; o["disclose"] = String(($("disclose") as HTMLInputElement).checked); return o; }
function directivesApplied() {
  const now = snapshotCfg();
  if (lastSnap) {
    const changes = Object.keys(now).filter((k) => now[k] !== lastSnap![k]).map((k) => `${CFG_LABELS[k] ?? k} ${lastSnap![k] || "blank"} → ${now[k] || "blank"}`);
    if (changes.length) sys(`you changed: ${changes.join("; ")}. Pip plays this round with that.`, "directive");
  }
  lastSnap = now;
}
function setClockUi() {
  const b = $("clock") as HTMLButtonElement;
  const every = pipEvery();
  b.textContent = clockOn ? "Stop" : `Run every ${every >= 120 ? every / 60 + " min" : every + " s"}`;
  b.title = clockOn ? "stop after the current round" : `Pip keeps making deals on its own, one every ${every >= 120 ? every / 60 + " minutes" : every + " seconds"}, until you stop it`;
  b.classList.toggle("on", clockOn);
  ($("coach") as HTMLElement).style.display = clockOn ? "" : "none";
}
async function clockLoop() {
  setClockUi();
  lastSnap = snapshotCfg();
  while (clockOn) {
    tickN++;
    if (skipNext) { skipNext = false; sys(`round ${tickN}, ${new Date().toISOString().slice(11, 19)} UTC: skipped, as you asked`, "tick"); directivesApplied(); }
    else await run(tickN, directivesApplied);
    if (!clockOn) break;
    for (let sLeft = pipEvery(); sLeft > 0 && clockOn && !wakeNow; sLeft--) { status(`Pip is running on its own: next round in ${sLeft}s`); await wait(1000); }
    wakeNow = false;
  }
  status("");
  setClockUi();
}
$("clock").addEventListener("click", () => { clockOn = !clockOn; if (clockOn) clockLoop(); else { setClockUi(); status("stopping after this round"); } });
$("d-now").addEventListener("click", () => { wakeNow = true; });
$("d-skip").addEventListener("click", () => { skipNext = true; sys("noted: Pip will skip the next round", "directive"); });
window.addEventListener("beforeunload", (e) => { if (clockOn && running) { e.preventDefault(); } });
$("b-print").addEventListener("click", () => window.print());
$("b-txt").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lastTxt], { type: "text/plain" }));
  a.download = `receipt-${lastTx.slice(0, 8)}.txt`;
  a.click();
});
