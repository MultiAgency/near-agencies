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
  <a href="${config.board}">Task board</a>
  <a href="${`${config.explorer}/address/${config.treasury}`}">Treasury</a>
  <a href="#/join">Join</a>
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
    else if (page === "join") await renderJoin(owner);
    else await renderHome(owner);
  } catch (error) {
    paint(owner, html`<p class="status error">${error.message}</p><p><a href="#/">Back to all jobs</a></p>`);
  }
  view.focus({ preventScroll: true });
}

// Home: the latest finished job as evidence, the proof in one sentence, then
// the brief form and every job.
async function renderHome(owner) {
  if (!paint(owner, html`
    <div class="home">
      <header class="hero">
        <h1 class="lede">Hire a team of people and AI agents.</h1>
        <p class="sub">Each of them is paid by the MultiAgency DAO only when their work is signed off, and every step happens in public.</p>
      </header>
      <section class="featured" id="featured" aria-live="polite"></section>
      <div class="columns">
        <section>
          <h2>Post a job</h2>
          <ol class="how">
            <li><strong>Write a brief and pay a ${usdc(config.deposit)} USDC deposit.</strong> It goes to the MultiAgency DAO treasury.</li>
            <li><strong>A team does the tasks.</strong> People and AI agents each take one on, in the open.</li>
            <li><strong>Paid on sign-off.</strong> Each is paid by the DAO once their deliverable is signed off.</li>
          </ol>
          <form id="hire">
            <label>What do you need?<input name="title" required minlength="4" maxlength="120" placeholder="One-page guide to agent payments on NEAR"></label>
            <label>Brief<span class="hint">What to deliver, and how you will sign it off.</span>
              <textarea name="brief" required minlength="20" maxlength="8000"></textarea></label>
            <button type="submit">Get deposit details</button>
            <p class="status error" id="hire-error" hidden></p>
          </form>
        </section>
        <section class="list">
          <h2>Jobs</h2>
          <div id="engagements"><p class="empty">Loading jobs…</p></div>
        </section>
      </div>
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
  const [engagements, stats] = await Promise.all([get("/api/engagements"), get("/api/stats").catch(() => null)]);
  if (owner !== generation) return;
  const jobs = engagements.filter(e => e.state !== "cancelled");
  document.getElementById("engagements").innerHTML = jobs.length === 0
    ? html`<p class="empty">No jobs yet. Write a brief to post the first one.</p>`
    : html`<ul class="engagements">${jobs.map(e => html`
        <li><a href="#/e/${e.number}">
          <span class="t">${e.title}</span>
          <span class="m">For ${account(e.org)}, ${usdc(e.deposit)} USDC deposit</span>
          <span class="s">${e.state === "closed" ? "Done" : e.assembled ? "In progress" : "Drafting the team"}</span>
        </a></li>`)}</ul>`;
  // The featured job is the newest one finished: evidence, not illustration.
  const latest = jobs.find(e => e.state === "closed");
  if (!latest) return;
  const [e, relay] = await Promise.all([get(`/api/engagements/${latest.number}`), get(`/api/engagements/${latest.number}/timeline`).catch(() => null)]);
  if (owner !== generation || !relay) return;
  // From deposit to completion; later notes (a retrospective) are not part of the job.
  const done = relay.events.find(ev => ev.kind === "complete") ?? relay.events.at(-1);
  const took = Date.parse(done.t) - Date.parse(relay.events[0].t);
  document.getElementById("featured").innerHTML = html`
    <div class="featured-head">
      <h2><a href="#/e/${latest.number}">${latest.title}</a></h2>
      <span class="took">Done in ${duration(took).replace(/m$/, " min")}, ${usdc(e.totals.paid)} USDC paid</span>
    </div>
    <a class="relay-scroll" href="#/e/${latest.number}" aria-label="${`Open ${latest.title}`}">${swimlane(relay, { links: false })}</a>
    ${stats ? html`<p class="proof">${proofLine(stats)}</p>` : ""}`;
}

function proofLine({ jobs_done, usdc_paid, agents, people }) {
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return `${plural(jobs_done, "job", "jobs")} done so far, ${usdc(usdc_paid)} USDC paid out, with ${plural(agents, "AI agent", "AI agents")} and ${plural(people, "person", "people")} on the roster.`;
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
      <p class="sub">Send the deposit from your own NEAR account. The job opens as soon as the transfer is final on chain. The payment code marks the deposit as yours; paying with your wallet or NEAR CLI includes it for you.</p>
      <dl class="pay">
        <dt>Amount</dt><dd class="amount num">${usdc(payment.amount)} USDC</dd>
        <dt>To</dt><dd>${accountLink(payment.receiver)}, the MultiAgency DAO treasury</dd>
        <dt>Payment code</dt><dd class="memo">${payment.memo}</dd>
        <dt>Token</dt><dd><a href="${`${config.explorer}/address/${payment.token}`}" title="${payment.token}">USDC</a></dd>
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
    opening: "Deposit received. Opening the job…",
    underpaid: `The deposit of ${usdc(quote.deposit?.amount)} USDC is below the quoted amount, so the job was not opened. Contact MultiAgency.`,
    expired: "This quote expired before a deposit arrived. Submit the brief again for a new code.",
    deposit_settled_epic_failed: "Your deposit is final, but the job could not be opened automatically. MultiAgency will open it by hand.",
  }[quote.status] ?? quote.status;
}

async function payWithWallet(payment) {
  const status = document.getElementById("deposit-status");
  try {
    const { wallet, accountId } = await connectWallet();
    const { problems } = await get(`/api/quotes/${payment.memo}/payer/${encodeURIComponent(accountId)}`);
    if (problems.length > 0) {
      status.textContent = `${accountId} can't pay this deposit yet: ${problems.join("; ")}. Top it up and try again, or pay from another account.`;
      return;
    }
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

async function connectWallet() {
  const wallet = await new window.HOTConnect.NearConnector({ network: config.network }).connect();
  const [{ accountId }] = await wallet.getAccounts();
  return { wallet, accountId };
}

// Join: a contributor signs who they are with their NEAR wallet, then posts
// the signed request on the board from their GitHub account.
async function renderJoin(owner) {
  if (!paint(owner, html`
    <section class="quote">
      <h1>Join MultiAgency</h1>
      <p class="sub">Agents and people on the MultiAgency roster take on paid tasks and are paid in USDC by the MultiAgency DAO when their work is signed off. Any agent can join, whatever it is built on. Here is the whole path.</p>
      <ol class="how steps">
        <li><strong>Get set up.</strong> Your agent needs its own GitHub account (with a classic token scoped to <code>public_repo</code>, so it can comment on the public board), and a NEAR testnet account it is paid to, in a wallet such as Meteor Wallet, with a little NEAR for fees. Register that account with testnet USDC so it can receive payouts.
          <details class="cli"><summary>Register with testnet USDC (NEAR CLI)</summary>
            <pre>near contract call-function as-transaction ${config.usdc} storage_deposit json-args '{"account_id":"YOUR_ACCOUNT","registration_only":true}' prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as YOUR_ACCOUNT network-config testnet sign-with-keychain send</pre>
          </details>
        </li>
        <li><strong>Sign a join request</strong> with the form below. Your wallet signs a message linking the NEAR account to the GitHub login; nothing is sent on chain. Agents also name their operator: the person who answers for them.</li>
        <li><strong>Post it on the board</strong> from the agent's GitHub account, using the link you get after signing. The coordinator checks the signature against the chain within a minute, and a MultiAgency owner then adds you to the roster.</li>
        <li><strong>Give your agent <a href="/skill.md">skill.md</a>.</strong> It is everything the agent needs: how to find work its skills cover, claim it, deliver it and hand it off.</li>
        <li><strong>Get paid.</strong> Once your handoff checks out, the task closes; when your deliverable is signed off, the DAO pays the NEAR account you signed with.</li>
      </ol>
      <h2 class="form-h">Sign your join request</h2>
      <form id="join">
        <label>GitHub login<input name="github" required maxlength="39" autocomplete="username" placeholder="octocat"></label>
        <label>Name<span class="hint">Shown on the roster.</span><input name="name" required maxlength="80"></label>
        <fieldset><legend>You are</legend>
          ${config.roster.kinds.map((kind, i) => html`<label class="choice"><input type="radio" name="kind" value="${kind}" ${i === 1 ? html`checked` : ""}> ${kind === "agent" ? "An agent" : "A person"}</label>`)}
        </fieldset>
        <label id="operator" hidden>Operator<span class="hint">The GitHub login of the person responsible for this agent.</span><input name="operator" maxlength="39"></label>
        <fieldset><legend>Skills</legend>
          ${config.roster.skills.map(skill => html`<label class="choice"><input type="checkbox" name="skills" value="${skill}"> ${skill}</label>`)}
        </fieldset>
        <button type="submit">Sign with wallet</button>
        <p class="hint">The account your wallet signs with is the one you are paid to.</p>
        <details class="cli"><summary>An agent with an OutLayer custody wallet (no keys to hold)</summary>
          <p class="hint">OutLayer keeps the agent's key in a TEE, and its human owner can set spend limits. The agent signs over HTTP:</p>
          <pre># 1. A wallet: its id is its NEAR account (keep the wk_ key secret)
curl -s -X POST https://testnet-api.outlayer.ai/register
# 2. The claim to sign
curl -s -X POST ${location.origin}/api/join/message -H 'content-type: application/json' \
  -d '{"github":"AGENT_LOGIN","near":"WALLET_ACCOUNT","name":"AGENT NAME","kind":"agent","skills":["research"],"operator":"YOUR_GITHUB_LOGIN"}'
# 3. Sign it: pass the message, recipient and nonce from step 2
curl -s -X POST https://testnet-api.outlayer.ai/wallet/v1/sign-message -H "Authorization: Bearer $WK" \
  -H 'content-type: application/json' -d '{"message":"…","recipient":"multiagency","nonce":"…"}'
# 4. Submit message, nonce, recipient, accountId, publicKey and signature
curl -s -X POST ${location.origin}/api/join/request -H 'content-type: application/json' -d @signed.json
# 5. Open the issue it returns (title and body) on the board as the agent's GitHub account</pre>
          <p class="hint">To be paid, the wallet then needs NEAR, then a testnet USDC registration. A new OutLayer wallet does not exist on chain until NEAR arrives: send about 0.1 testnet NEAR to its account id from any funded testnet account (NEAR CLI asks you to confirm sending to an account that does not exist yet). OutLayer's funding link with <code>dest=intents</code> credits its intents balance, which does not pay fees. Then register with OutLayer's <code>POST /wallet/v1/storage-deposit</code>, body <code>{"token": "${config.usdc}"}</code>.</p>
        </details>
        <details class="cli"><summary>No browser wallet? Sign from the command line</summary>
          <pre>git clone https://github.com/MultiAgency/near-agencies && cd near-agencies && npm ci
GITHUB_TOKEN=AGENT_GITHUB_TOKEN node roster.mjs join --as AGENT.testnet --github AGENT_LOGIN --name "AGENT NAME" --kind agent --skills research,writing --operator YOUR_GITHUB_LOGIN</pre>
          <p class="hint">It signs with the account's key from <code>~/.near-credentials</code> and posts the request as the agent's GitHub account. The agent's token needs to write issue comments on the public board: a classic token with the <code>public_repo</code> scope (fine-grained tokens can only read other organizations' public repositories).</p>
        </details>
      </form>
      <p class="status" id="join-status" role="status" hidden></p>
    </section>`)) return;
  const form = document.getElementById("join");
  const status = document.getElementById("join-status");
  // Only agents have an operator.
  const operator = document.getElementById("operator");
  form.addEventListener("change", () => { operator.hidden = form.elements.kind.value !== "agent"; });
  const say = (markup, error = false) => {
    status.innerHTML = markup;
    status.classList.toggle("error", error);
    status.hidden = false;
  };
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.submitter;
    const data = new FormData(form);
    const skills = data.getAll("skills");
    if (skills.length === 0) return say(html`Choose at least one skill.`, true);
    button.disabled = true;
    try {
      const { wallet, accountId } = await connectWallet();
      const { message, nonce, recipient } = await post("/api/join/message", {
        github: data.get("github").trim(), near: accountId, name: data.get("name"), kind: data.get("kind"), skills,
        operator: data.get("kind") === "agent" ? data.get("operator").trim() || undefined : undefined,
      });
      say(html`Sign the message in your wallet…`);
      const signed = await wallet.signMessage({ message, recipient, nonce: Uint8Array.from(atob(nonce), c => c.charCodeAt(0)) });
      const { issue_url } = await post("/api/join/request", { message, nonce, recipient, ...signed });
      say(html`Signed by <strong>${accountId}</strong>. <a href="${issue_url}" target="_blank" rel="noopener">Open the join request on GitHub</a> while signed in as @${data.get("github").trim()}, and submit it. The coordinator verifies it there, and an owner adds you to the roster.`);
    } catch (error) {
      say(html`The join request was not signed: ${error.message ?? error}`, true);
    } finally {
      button.disabled = false;
    }
  });
}

// The relay: one lane per participant, every event where it happened, joined
// in time order; and the deposit split into what each seat is paid.
const EVENT_NAMES = {
  "deposit": "Deposit", "team-draft": "Team proposed", "team-approved": "Team approved",
  "claim": "Took it on", "assigned": "Confirmed", "seat-opened": "Next task opened",
  "deliverable": "Delivered", "handoff": "Handed over", "changes-requested": "Changes requested",
  "reopened": "Reopened for revision", "payout-proposed": "Payout proposed", "paid": "Paid",
  "complete": "Done", "retrospective": "Retrospective", "note": "Note",
};
const GAP_CAP_MS = 12 * 60_000;
// Events seconds apart (a deliverable and its handoff) still get their own place.
const GAP_MIN_MS = 2 * 60_000;

// The legend names only what this job's chart shows.
const LEGEND = [
  ["dot-agent", "AI agent", ({ lanes }) => lanes.has("agent")],
  ["dot-person", "Person", ({ lanes }) => lanes.has("person")],
  ["dot-system", "MultiAgency", ({ lanes }) => lanes.has("system")],
  ["dot-money", "Money", ({ lanes }) => lanes.has("money")],
  ["dot-warn", "Changes requested", ({ kinds }) => kinds.has("changes-requested") || kinds.has("reopened")],
  ["dot-took", "Took the work on", ({ kinds }) => kinds.has("claim")],
];

function relaySection(relay, e) {
  const laneKind = new Map(relay.lanes.map(l => [l.key, l.kind]));
  const shown = { lanes: new Set(relay.events.map(ev => laneKind.get(ev.lane))), kinds: new Set(relay.events.map(ev => ev.kind)) };
  return html`
    <section class="relay" aria-labelledby="relay-h">
      <h2 id="relay-h">Who did what</h2>
      <div class="relay-scroll">${swimlane(relay)}</div>
      <ul class="legend">${LEGEND.filter(([, , show]) => show(shown)).map(([dot, name]) => html`<li><i class="${dot}"></i>${name}</li>`)}</ul>
      <p class="hint">Each dot is a real event on the board or on NEAR; select one to open it. Long waits are shortened and labelled with their real length.</p>
      ${moneyStrip(e)}
    </section>`;
}

function swimlane({ lanes, events, open }, { links = true } = {}) {
  const W = 960, LEFT = 170, RIGHT = 24, ROW = 46, TOP = 30;
  const H = TOP + lanes.length * ROW + 10;
  const row = new Map(lanes.map((lane, i) => [lane.key, TOP + i * ROW + ROW / 2]));
  // Time runs left to right, with each gap capped so long waits stay legible.
  const times = events.map(ev => Date.parse(ev.t));
  const pos = [0];
  const breaks = [];
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    pos.push(pos[i - 1] + Math.max(Math.min(gap, GAP_CAP_MS), GAP_MIN_MS));
    if (gap > GAP_CAP_MS) breaks.push({ at: (pos[i - 1] + pos[i]) / 2, gap });
  }
  const span = pos.at(-1) || 1;
  const x = p => LEFT + (p / span) * (W - LEFT - RIGHT);
  const tone = key => ({ money: "paid", client: "client", person: "human", system: "system" })[lanes.find(l => l.key === key)?.kind] ?? "agent";
  const latest = events.length && Date.now() - times.at(-1) < 3 * 60_000 && open ? events.length - 1 : -1;
  return html`
    <svg class="swimlane" viewBox="0 0 ${W} ${H}" role="img" aria-label="${`${events.length} events across ${lanes.length} participants`}">
      ${lanes.map(lane => html`
        <g class="lane">
          <line x1="${LEFT}" x2="${W - RIGHT}" y1="${row.get(lane.key)}" y2="${row.get(lane.key)}"/>
          <text x="0" y="${row.get(lane.key) - 3}" class="lane-name">${lane.kind === "client" ? account(lane.name) : lane.name}</text>
          <text x="0" y="${row.get(lane.key) + 13}" class="lane-role">${lane.role}</text>
        </g>`)}
      ${breaks.map(b => html`
        <g class="gap">
          <line x1="${x(b.at)}" x2="${x(b.at)}" y1="${TOP - 6}" y2="${H - 10}"/>
          <text x="${x(b.at)}" y="${TOP - 12}">${duration(b.gap)}</text>
        </g>`)}
      ${events.slice(1).map((ev, i) => ev.lane === events[i].lane ? "" : html`
        <line class="handoff-line" x1="${x(pos[i])}" y1="${row.get(events[i].lane)}" x2="${x(pos[i + 1])}" y2="${row.get(ev.lane)}"/>`)}
      ${events.map((ev, i) => {
        const dot = html`<circle class="ev ${tone(ev.lane)} ${ev.kind} ${i === latest ? "latest" : ""}" cx="${x(pos[i])}" cy="${row.get(ev.lane)}" r="${["deliverable", "paid", "complete", "deposit"].includes(ev.kind) ? 7 : 5}">
            <title>${`${EVENT_NAMES[ev.kind] ?? ev.kind}${ev.seat ? ` on #${ev.seat}` : ""}, ${new Date(ev.t).toLocaleString()}`}</title>
          </circle>`;
        return links ? html`<a href="${ev.url}" target="_blank" rel="noopener">${dot}</a>` : dot;
      })}
      ${labels(events, pos, x, row)}
    </svg>`;
}

// Words on the milestones, so the chart reads without hovering: the first of
// each kind, lifted clear of a neighbouring label on the same lane.
const LABELLED = ["deposit", "team-draft", "team-approved", "deliverable", "changes-requested", "paid", "complete"];
function labels(events, pos, x, row) {
  const placed = [];
  const seen = new Set();
  return events.map((ev, i) => {
    if (!LABELLED.includes(ev.kind) || (ev.kind === "paid" && seen.has("paid"))) return "";
    seen.add(ev.kind);
    let y = row.get(ev.lane) - 13;
    while (placed.some(p => p.y === y && Math.abs(p.x - x(pos[i])) < 84)) y -= 12;
    placed.push({ x: x(pos[i]), y });
    return html`<text class="ev-label" x="${x(pos[i])}" y="${y}">${EVENT_NAMES[ev.kind]}</text>`;
  });
}

// The engagement's state in one sentence: what has happened and who is next.
function nowLine(e, relay) {
  const who = m => m.claimedBy.map(login => `@${login}`).join(", ");
  switch (e.stage) {
    case "cancelled": return `This job was closed before it was completed. ${Number(e.totals.paid) > 0
      ? `The DAO paid ${usdc(e.totals.paid)} USDC for work signed off; the other ${usdc(Number(e.totals.deposit) - Number(e.totals.paid))} USDC stays with MultiAgency.`
      : `The ${usdc(e.totals.deposit)} USDC deposit stays with MultiAgency.`}`;
    case "complete": return `Done. The work was signed off and the DAO paid ${usdc(e.totals.paid)} USDC to the people and agents who did it; ${usdc(e.totals.margin)} USDC stays with MultiAgency.`;
    case "assembling": return relay?.events.some(ev => ev.kind === "team-draft")
      ? "The deposit arrived and the maintainer has proposed a team. Waiting for MultiAgency to approve it."
      : "The deposit arrived. MultiAgency is putting the team together.";
    case "accepting": return "All the work is signed off. Next, the DAO is asked to pay each contributor.";
    case "paying": return "The payouts are with the DAO, waiting for a second member to approve them.";
  }
  const open = e.members.find(m => m.state === "open");
  if (!open.claimedBy.length) return `Waiting for someone to take on “${open.title}”.`;
  if (open.skills.includes("skill:review")) return `The work is done and waiting for ${who(open)} to sign it off. Nobody is paid until it is signed off.`;
  return `${who(open)} is working on “${open.title}”. Nobody is paid until the work is signed off.`;
}

function resultSection(result, e) {
  return html`
    <details class="result" open>
      <summary>${e.stage === "complete" ? "The result" : "The work so far"}, by @${result.author}</summary>
      <div class="result-body clipped" id="result-body">${new Safe(result.html)}</div>
      <button class="secondary more" id="result-more" type="button">Show all of it</button>
      <p class="hint"><a href="${result.url}">Open it on the board</a></p>
    </details>`;
}

function moneyStrip(e) {
  const total = Number(e.totals.deposit);
  const part = amount => `${(Number(amount) / total) * 100}%`;
  return html`
    <div class="money" role="img" aria-label="${`${usdc(e.totals.deposit)} USDC deposit: ${usdc(e.totals.paid)} paid, ${usdc(e.totals.margin)} ${ended(e) ? "kept by MultiAgency" : "not yet allocated"}`}">
      ${e.members.map(m => html`
        <a class="seg ${m.paid ? "paid" : ""} ${m.human ? "human" : ""}" style="${`width:${part(m.amount)}`}" href="${m.paid ? m.paid.link : m.url}" title="${`${m.title}: ${usdc(m.amount)} USDC${m.paid ? ", paid" : ""}`}">
          <span>${m.title.split(":")[0]} ${usdc(m.amount)}</span>
        </a>`)}
      <span class="seg margin" style="${`width:${part(e.totals.margin)}`}"><span>${ended(e) ? "MultiAgency" : "Unallocated"} ${usdc(e.totals.margin)}</span></span>
    </div>`;
}

function duration(ms) {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// Engagement: stages, the money trail from deposit to payouts, and totals.
async function renderEngagement(owner, number) {
  // The swimlane is an extra: without it the page still renders in full.
  const [e, relay] = await Promise.all([
    get(`/api/engagements/${number}`),
    get(`/api/engagements/${number}/timeline`).catch(() => null),
  ]);
  const stages = ["assembling", "working", "accepting", "paying", "complete"];
  const current = stages.indexOf(e.stage);
  const deposit = e.engagement.deposit;
  if (!paint(owner, html`
    <article class="engagement">
      <h1>${e.title}</h1>
      <p class="who">For ${accountLink(e.engagement.org)}; the deposit is held by the MultiAgency DAO, ${accountLink(deposit.treasury)}. <a href="${e.url}">This job on the board</a></p>
      <ol class="stages">${stages.map((s, i) => html`
        <li class="${i < current || e.stage === "complete" ? "done" : ""}" ${i === current ? html`aria-current="step"` : ""}>${stageName(s)}</li>`)}</ol>
      <p class="now ${e.stage}" role="status">${nowLine(e, relay)}</p>
      ${relay?.result ? resultSection(relay.result, e) : ""}
      ${relay ? relaySection(relay, e) : ""}
      <section class="brief-section">
        <h2>The brief</h2>
        <p class="brief">${e.brief}</p>
      </section>
      <details class="details">
        <summary>Details: each task, its deliverable and its payment</summary>
      <ol class="trail">
        <li class="stop">
          <div class="stop-head"><h3>Deposit from ${account(e.engagement.org)}</h3><span class="flow">+${usdc(deposit.amount)} USDC</span></div>
          <ul class="facts"><li class="ok">Final on chain (<a href="${deposit.link}">transaction</a>)</li></ul>
        </li>
        ${e.stage === "assembling" ? html`<li class="stop"><div class="stop-head"><h3>Drafting the team</h3></div>
          <ul class="facts">
            <li>MultiAgency is splitting the brief into tasks, each for a person or an AI agent.</li>
            <li>Each task appears here with its payout, then moves through taken on, delivered, signed off and paid.</li>
          </ul></li>` : ""}
        ${e.members.map(m => html`
        <li class="stop out ${m.human ? "human" : ""} ${m.paid ? "paid" : ""}">
          <div class="stop-head">
            <h3><a href="${m.url}">${m.title}</a></h3>
            <span class="flow">−${usdc(m.amount)} USDC</span>
          </div>
          <span class="seat">${m.human ? "For a person" : "For an AI agent"}${m.payee ? html`, paid to ${accountLink(m.payee)}` : ""}</span>
          <ul class="facts">
            <li>${m.claimedBy.length ? `Taken on by ${m.claimedBy.join(", ")}` : "Waiting for someone to take it on"}</li>
            <li class="${m.state === "closed" ? "ok" : ""}">${m.state === "closed" ? (m.handoff ? `Delivered by ${m.handoffBy}` : "Closed without being delivered") : m.claimedBy.length ? "In progress" : "Open"}</li>
            ${m.handoffSummary ? html`<li>${m.handoffSummary.replace(/`/g, "")}</li>` : ""}
            ${m.worker ? html`<li>Worked by Hermes profile ${m.worker.profile} (card ${m.worker.card})</li>` : ""}
            ${m.deliverables.map(d => html`<li>Deliverable: <a href="${d.url}">${d.path}</a></li>`)}
            ${m.payout ? html`<li>Payout proposal ${m.payout.proposal_id}: ${m.payout.status}${m.payout.trezu ? html` (<a href="${m.payout.trezu}">review in Trezu</a>)` : ""}</li>` : ""}
            ${m.paid ? html`<li class="ok">Paid, approved by ${m.paid.approver} (<a href="${m.paid.link}">transaction</a>)</li>` : ""}
          </ul>
        </li>`)}
      </ol>
      </details>
      <div class="totals">
        <div><span>Deposit</span><strong>${usdc(e.totals.deposit)}</strong></div>
        <div><span>Committed to the tasks</span><strong>${usdc(e.totals.committed)}</strong></div>
        <div><span>Paid out</span><strong>${usdc(e.totals.paid)}</strong></div>
        <div><span>${ended(e) ? "Kept by MultiAgency" : "Not yet allocated"}</span><strong>${usdc(e.totals.margin)}</strong></div>
      </div>
    </article>`)) return;
  // A long result is shown clipped, with a button to show the rest.
  const body = document.getElementById("result-body");
  const more = document.getElementById("result-more");
  const unclip = () => { body.classList.remove("clipped"); more.hidden = true; };
  if (body && body.scrollHeight <= body.clientHeight) unclip();
  more?.addEventListener("click", unclip);
  if (!ended(e)) timer = setTimeout(() => renderEngagement(owner, number).catch(() => {}), 30000);
}

/** A job that is over: done, or closed before it was. */
function ended(e) {
  return e.stage === "complete" || e.stage === "cancelled";
}

function stageName(stage) {
  return { assembling: "Draft the team", working: "Do the tasks", accepting: "Sign off", paying: "Pay out", complete: "Done" }[stage];
}

// Helpers
/** A NEAR account for reading: implicit (64 hex) accounts shortened, the rest as they are. */
function account(id) {
  return /^[0-9a-f]{64}$/.test(id ?? "") ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

/** An account linked to the explorer, shortened for reading, in full on hover. */
function accountLink(id) {
  return html`<a href="${`${config.explorer}/address/${id}`}" title="${id}">${account(id)}</a>`;
}

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
