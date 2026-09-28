// MultiAgency demo app: hire a team, pay the deposit from your own wallet,
// and follow the engagement from deposit to payouts.

// Tagged template that escapes interpolated values; nested html`` results and
// arrays of them pass through unescaped.
function html(strings, ...values) {
  const render = value => {
    if (Array.isArray(value)) return value.map(render).join("");
    if (value instanceof Safe) return value.value;
    return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  };
  return new Safe(strings.reduce((out, s, i) => out + s + (i < values.length ? render(values[i]) : ""), ""));
}
class Safe {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

const view = document.getElementById("view");
const config = await get("/api/config");
let timer;
let generation = 0;

// Write a view only if no newer route has started since it began loading.
function paint(owner, markup) {
  if (owner !== generation) return false;
  view.innerHTML = markup;
  return true;
}

document.getElementById("net").textContent = `NEAR ${config.network}`;
document.getElementById("net").dataset.network = config.network;
document.getElementById("bar-links").innerHTML = html`
  <a href="${config.board}">Kanban board</a>
  <a href="${`${config.explorer}/address/${config.treasury}`}">Treasury</a>
  ${config.trezu ? html`<a href="${config.trezu}">Trezu</a>` : ""}`;

window.addEventListener("hashchange", route);
route();

async function route() {
  clearTimeout(timer);
  const owner = ++generation;
  const [, page, id] = location.hash.split("/");
  paint(owner, html`<p class="empty" role="status">Loading…</p>`);
  try {
    if (page === "q") await renderQuote(owner, id);
    else if (page === "e") await renderEngagement(owner, Number(id));
    else await renderHome(owner);
  } catch (error) {
    paint(owner, html`<p class="status error">${error.message}</p><p><a href="#/">Back to engagements</a></p>`);
  }
  view.focus({ preventScroll: true });
}

// Home: the hire form and the engagement list.
async function renderHome(owner) {
  if (!paint(owner, html`
    <div class="home">
      <section>
        <h1 class="lede">Hire a team of people and agents for one brief.</h1>
        <p class="sub">Describe the work and pay a ${usdc(config.deposit)} USDC deposit into the MultiAgency treasury. We assemble the team on a public kanban board, and each contributor is paid from the treasury when you accept their work.</p>
        <form id="hire">
          <label>What do you need?<input name="title" required minlength="4" maxlength="120" placeholder="One-page brief on agent payments"></label>
          <label>Brief<span class="hint">Scope, deliverables, and how you will judge the result.</span>
            <textarea name="brief" required minlength="20" maxlength="8000"></textarea></label>
          <button type="submit">Get deposit details</button>
          <p class="status error" id="hire-error" hidden></p>
        </form>
      </section>
      <section class="list">
        <h2>Engagements</h2>
        <div id="engagements"><p class="empty">Loading engagements…</p></div>
      </section>
    </div>`)) return;
  document.getElementById("hire").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    try {
      const quote = await post("/api/quotes", Object.fromEntries(new FormData(event.target)));
      location.hash = `#/q/${quote.code}`;
    } catch (error) {
      const message = document.getElementById("hire-error");
      message.textContent = error.message;
      message.hidden = false;
      button.disabled = false;
    }
  });
  const engagements = (await get("/api/engagements")).filter(e => e.state !== "cancelled");
  if (owner !== generation) return;
  document.getElementById("engagements").innerHTML = engagements.length === 0
    ? html`<p class="empty">No engagements yet. Submit a brief to open the first one.</p>`
    : html`<ul class="engagements">${engagements.map(e => html`
        <li><a href="#/e/${e.number}">
          <span class="t">${e.title}</span>
          <span class="m">${e.org}, ${usdc(e.deposit)} USDC on ${e.network}</span>
          <span class="s">${{ closed: "Complete", cancelled: "Cancelled" }[e.state] ?? (e.assembled ? "In progress" : "Assembling team")}</span>
        </a></li>`)}</ul>`;
}

// Quote: deposit instructions, wallet payment, and live deposit status.
async function renderQuote(owner, code) {
  const quote = await get(`/api/quotes/${code}`);
  if (quote.status === "open") {
    location.hash = `#/e/${quote.issue}`;
    return;
  }
  const { payment } = quote;
  const args = JSON.stringify({ receiver_id: payment.receiver, amount: payment.amount, memo: payment.memo });
  if (!paint(owner, html`
    <section class="quote">
      <h1>${quote.title}</h1>
      <p class="sub">Send the deposit from your own NEAR account. The engagement opens as soon as the transfer is final on chain.</p>
      <dl class="pay">
        <dt>Amount</dt><dd class="amount num">${usdc(payment.amount)} USDC</dd>
        <dt>To</dt><dd>${payment.receiver}</dd>
        <dt>Memo</dt><dd class="memo">${payment.memo}</dd>
        <dt>Token</dt><dd>${payment.token}</dd>
        <dt>Valid until</dt><dd>${new Date(quote.expires_at).toLocaleString()}</dd>
      </dl>
      <div class="actions">
        <button id="wallet" type="button">Pay with wallet</button>
        <span class="hint">Your account pays a little NEAR for gas, and must hold the USDC.</span>
      </div>
      ${config.trezu ? html`<p class="hint">Paying from your own Trezu treasury? Create a payment request to ${payment.receiver} for ${usdc(payment.amount)} USDC and put ${payment.memo} in the notes.</p>` : ""}
      <details class="cli"><summary>Pay with NEAR CLI</summary>
        <pre>near contract call-function as-transaction ${payment.token} ft_transfer json-args '${args}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as YOUR_ACCOUNT network-config ${payment.network} sign-with-keychain send</pre>
      </details>
      <p class="status" id="deposit-status" role="status">${statusText(quote)}</p>
    </section>`)) return;
  document.getElementById("wallet").addEventListener("click", () => payWithWallet(payment));
  const poll = async () => {
    const latest = await get(`/api/quotes/${code}`);
    if (owner !== generation) return;
    if (latest.status === "open") return void (location.hash = `#/e/${latest.issue}`);
    document.getElementById("deposit-status").textContent = statusText(latest);
    if (latest.status === "awaiting_deposit" || latest.status === "opening") timer = setTimeout(poll, 5000);
  };
  timer = setTimeout(poll, 5000);
}

function statusText(quote) {
  return {
    awaiting_deposit: "Waiting for your deposit. This page updates when it lands.",
    opening: "Deposit received. Opening the engagement…",
    underpaid: `The deposit of ${usdc(quote.deposit?.amount)} USDC is below the quoted amount, so the engagement was not opened. Contact MultiAgency.`,
    expired: "This quote expired before a deposit arrived. Submit the brief again for a new code.",
    deposit_settled_epic_failed: "Your deposit is final, but the engagement could not be opened automatically. MultiAgency will open it by hand.",
  }[quote.status] ?? quote.status;
}

async function payWithWallet(payment) {
  const status = document.getElementById("deposit-status");
  try {
    const connector = new window.HOTConnect.NearConnector({ network: payment.network });
    const wallet = await connector.connect();
    status.textContent = "Confirm the transfer in your wallet…";
    await wallet.signAndSendTransaction({
      receiverId: payment.token,
      actions: [{
        type: "FunctionCall",
        params: {
          methodName: "ft_transfer",
          args: { receiver_id: payment.receiver, amount: payment.amount, memo: payment.memo },
          gas: "30000000000000",
          deposit: "1",
        },
      }],
    });
    status.textContent = "Transfer sent. Waiting for it to be final…";
  } catch (error) {
    status.textContent = `Wallet payment did not complete: ${error.message ?? error}. You can retry or pay with NEAR CLI.`;
  }
}

// Engagement: stages, the money trail from deposit to payouts, and totals.
async function renderEngagement(owner, number) {
  const e = await get(`/api/engagements/${number}`);
  const stages = ["assembling", "working", "accepting", "paying", "complete"];
  const current = stages.indexOf(e.stage);
  const deposit = e.engagement.deposit;
  if (!paint(owner, html`
    <article class="engagement">
      <h1>${e.title}</h1>
      <p class="who">For ${e.engagement.org}, deposit held by ${deposit.treasury}. <a href="${e.url}">Epic on the board</a></p>
      ${e.stage === "cancelled" ? html`<p class="status error">This engagement was closed without being completed.</p>` : ""}
      <ol class="stages">${stages.map((s, i) => html`
        <li class="${i < current || e.stage === "complete" ? "done" : ""}" ${i === current ? html`aria-current="step"` : ""}>${stageName(s)}</li>`)}</ol>
      <p class="brief">${e.brief}</p>
      <ol class="trail">
        <li class="stop">
          <div class="stop-head"><h3>Deposit from ${e.engagement.org}</h3><span class="flow">+${usdc(deposit.amount)} USDC</span></div>
          <ul class="facts"><li class="ok">Final on chain (<a href="${deposit.link}">transaction</a>)</li></ul>
        </li>
        ${e.members.length === 0 ? html`<li class="stop"><div class="stop-head"><h3>Assembling the team</h3></div>
          <ul class="facts">
            <li>MultiAgency is splitting the brief into pieces of work and choosing a person or an agent for each one.</li>
            <li>Each piece appears here with its payout, then moves through claimed, handed off and paid.</li>
          </ul></li>` : ""}
        ${e.members.map(m => html`
        <li class="stop out ${m.human ? "human" : ""} ${m.paid ? "paid" : ""}">
          <div class="stop-head">
            <h3><a href="${m.url}">${m.title}</a></h3>
            <span class="flow">−${usdc(m.amount)} USDC</span>
          </div>
          <span class="seat">${m.human ? "Human seat" : "Agent seat"}, paid to ${m.payee}</span>
          <ul class="facts">
            <li>${m.claimedBy.length ? `Claimed by ${m.claimedBy.join(", ")}` : "Waiting to be claimed"}</li>
            <li class="${m.state === "closed" ? "ok" : ""}">${m.state === "closed" ? (m.handoff ? `Handed off by ${m.handoffBy}` : "Closed without a handoff") : m.claimedBy.length ? "In progress" : "Open"}</li>
            ${m.handoffSummary ? html`<li>${m.handoffSummary.replace(/`/g, "")}</li>` : ""}
            ${m.worker ? html`<li>Worked by Hermes profile ${m.worker.profile} (card ${m.worker.card})</li>` : ""}
            ${m.deliverables.map(d => html`<li>Deliverable: <a href="${d.url}">${d.path}</a></li>`)}
            ${m.payout ? html`<li>Payout proposal ${m.payout.proposal_id}: ${m.payout.status}${m.payout.trezu ? html` (<a href="${m.payout.trezu}">review in Trezu</a>)` : ""}</li>` : ""}
            ${m.paid ? html`<li class="ok">Paid, approved by ${m.paid.approver} (<a href="${m.paid.link}">transaction</a>)</li>` : ""}
          </ul>
        </li>`)}
      </ol>
      <div class="totals">
        <div><span>Deposit</span><strong>${usdc(e.totals.deposit)}</strong></div>
        <div><span>Committed to the team</span><strong>${usdc(e.totals.committed)}</strong></div>
        <div><span>Paid out</span><strong>${usdc(e.totals.paid)}</strong></div>
        <div><span>${e.stage === "complete" ? "Kept by MultiAgency" : "Not yet allocated"}</span><strong>${usdc(e.totals.margin)}</strong></div>
      </div>
    </article>`)) return;
  if (e.stage !== "complete" && e.stage !== "cancelled") timer = setTimeout(() => renderEngagement(owner, number).catch(() => {}), 30000);
}

function stageName(stage) {
  return { assembling: "Assemble the team", working: "Do the work", accepting: "Accept the work", paying: "Approve payouts", complete: "Complete" }[stage];
}

// Helpers
function usdc(atomic) {
  const value = Number(atomic ?? 0) / 1e6;
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

async function get(path) {
  const response = await fetch(path);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `${path} returned ${response.status}`);
  return body;
}

async function post(path, data) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `${path} returned ${response.status}`);
  return body;
}
