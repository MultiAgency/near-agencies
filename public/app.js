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
// A vote in progress holds the job page's refresh, which would repaint the panel under the wallet.
let voting = false;

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

// The "Check status" box, shared by the Join page and the status page's error
// states. An unusable login ("@" alone, spaces) is answered where it was typed
// instead of landing on an empty lookup.
const lookupBox = html`<form class="lookup" id="lookup">
  <label>Already signed up? See where you stand and what to do next.<span class="lookup-row"><input name="login" required maxlength="39" autocomplete="username" placeholder="Your GitHub login" aria-label="Your GitHub login"><button class="secondary" type="submit">Check status</button></span></label>
  <p class="status error" hidden></p>
</form>`;

function wireLookup(preset) {
  const form = document.getElementById("lookup");
  const say = text => {
    const note = form.querySelector(".status.error");
    note.textContent = text;
    note.hidden = false;
  };
  if (preset) say(preset);
  form.addEventListener("submit", event => {
    event.preventDefault();
    const login = new FormData(event.target).get("login").trim().replace(/^@/, "");
    if (!login) return say("Enter your GitHub login.");
    location.hash = `#/status/${encodeURIComponent(login)}`;
  });
}

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
    else if (page === "status") await renderStatus(owner, decodeURIComponent(id ?? ""));
    else await renderHome(owner);
  } catch (error) {
    if (paint(owner, html`<p class="status error">${error.message}</p>
      ${page === "status" ? html`<h2 class="form-h">Check another login</h2>${lookupBox}` : ""}
      <p><a href="#/">Back to all jobs</a></p>`) && page === "status") wireLookup();
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
      <figure class="featured" id="featured" aria-live="polite">
        <div class="relay-scroll relay-placeholder"><div></div></div>
        <figcaption></figcaption>
      </figure>
      <p class="proof" id="proof"></p>
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
            <label>Repository<span class="hint">Where code tasks deliver their pull requests.</span>
              <select name="repo"><option value="" selected>${config.defaultRepo}</option>${config.repos.filter(r => r !== config.defaultRepo).map(r => html`<option value="${r}">${r}</option>`)}</select></label>
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
  if (stats) document.getElementById("proof").textContent = proofLine(stats);
  const jobs = engagements.filter(e => e.state !== "cancelled");
  document.getElementById("engagements").innerHTML = jobs.length === 0
    ? html`<p class="empty">No jobs yet. Write a brief to post the first one.</p>`
    : html`<ul class="engagements">${jobs.map(e => html`
        <li><a href="#/e/${e.number}">
          <span class="t">${e.title}</span>
          <span class="m">For ${account(e.org)}, ${Number(e.deposit) ? `${usdc(e.deposit)} USDC deposit` : "no deposit"}</span>
          <span class="s">${e.state === "closed" ? "Done" : e.assembled ? "In progress" : "Drafting the team"}</span>
        </a></li>`)}</ul>`;
  // The hero's figure is the newest finished job: evidence, not illustration.
  const featured = document.getElementById("featured");
  const latest = jobs.find(e => e.state === "closed");
  const [e, relay] = latest
    ? await Promise.all([get(`/api/engagements/${latest.number}`).catch(() => null), get(`/api/engagements/${latest.number}/timeline`).catch(() => null)])
    : [];
  if (owner !== generation) return;
  if (!e || !relay) return void featured.remove();
  featured.innerHTML = html`
    <a class="relay-scroll" href="#/e/${latest.number}" aria-label="${`Open ${latest.title}`}">${swimlane(relay, { links: false, reveal: true })}</a>
    <figcaption>
      <a class="caption-title" href="#/e/${latest.number}">${latest.title}</a>
      <p>${story(e, relay)}</p>
    </figcaption>`;
}

// A finished job in one paragraph: who paid, who did the work, the sign-off,
// the payouts, and how long it took from deposit to done.
function story(e, relay) {
  const kind = new Map(relay.lanes.map(lane => [lane.key, lane.kind]));
  const reviews = e.members.filter(m => m.skills.includes("skill:review"));
  const who = members => [...new Set(members.map(m => m.handoffBy).filter(Boolean))];
  const workers = who(e.members.filter(m => !reviews.includes(m)))
    .map(login => `@${login}, ${kind.get(login) === "agent" ? "an AI agent" : "a person"},`);
  const reviewers = who(reviews).map(login => `@${login}`);
  const rounds = relay.events.filter(ev => ev.kind === "changes-requested").length;
  // From deposit to completion; later notes (a retrospective) are not part of the job.
  const done = relay.events.find(ev => ev.kind === "complete") ?? relay.events.at(-1);
  const minutes = Math.round((Date.parse(done.t) - Date.parse(relay.events[0].t)) / 60_000);
  const took = minutes < 60 ? `${minutes}\u00a0minutes` : `${Math.floor(minutes / 60)}\u00a0h ${minutes % 60}\u00a0min`;
  const signOff = reviewers.length
    ? `${reviewers.join(" and ")} ${rounds ? `asked for ${rounds === 1 ? "one round" : `${rounds} rounds`} of changes and ` : ""}signed it off`
    : "it was signed off";
  const board = e.engagement.channel === "board";
  return [
    board
      ? `${account(e.engagement.org)} opened this job from the board with no deposit.`
      : `${account(e.engagement.org)} paid a ${usdc(e.totals.deposit)} USDC deposit.`,
    workers.length ? `${workers.join(" and ")} did the work; ${signOff};` : `${signOff[0].toUpperCase()}${signOff.slice(1)};`,
    board
      ? `nobody was paid, because the work was volunteer. ${took} from open to done.`
      : `the DAO paid ${usdc(e.totals.paid)} USDC. ${took} from deposit to done.`,
  ].join(" ");
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
  addCopyButtons();
  const poll = async () => {
    const latest = await get(`/api/quotes/${code}`);
    if (owner !== generation) return;
    if (latest.status === "open") return void (location.hash = `#/e/${latest.issue}`);
    document.getElementById("deposit-status").textContent = statusText(latest);
    if (["awaiting_deposit", "opening"].includes(latest.status) || (latest.status === "deposit_settled_epic_failed" && !latest.gave_up)) timer = setTimeout(poll, 5000);
  };
  timer = setTimeout(poll, 5000);
}

function statusText(quote) {
  return {
    awaiting_deposit: "Waiting for your deposit. This page updates when it lands.",
    opening: "Deposit received. Opening the job…",
    underpaid: `The deposit of ${usdc(quote.deposit?.amount)} USDC is below the quoted amount, so the job was not opened. Contact MultiAgency.`,
    expired: "This quote expired before a deposit arrived. Submit the brief again for a new code.",
    deposit_settled_epic_failed: quote.gave_up
      ? "Your deposit is final, but the job could not be opened automatically. MultiAgency will follow up."
      : "Your deposit is final. The job is being opened and this page updates when it is.",
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
      ${lookupBox}
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
  addCopyButtons();
  wireLookup();
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
      // Passed explicitly so it is known: wallets that sign over a callbackUrl
      // (Meteor uses the page's address when none is given) sign over this one.
      const callbackUrl = location.href;
      const signed = await wallet.signMessage({ message, recipient, nonce: Uint8Array.from(atob(nonce), c => c.charCodeAt(0)), callbackUrl });
      if (!signed.publicKey) throw new Error("the wallet returned no public key");
      // JSON cannot carry bytes, so a wallet that returns them is sent as base64.
      const signature = signed.signature instanceof Uint8Array ? btoa(String.fromCharCode(...signed.signature)) : signed.signature;
      const { issue_url } = await post("/api/join/request", {
        message, nonce, recipient, accountId: signed.accountId ?? accountId, publicKey: signed.publicKey, signature, callbackUrl,
      });
      const login = data.get("github").trim();
      say(html`Signed by <strong>${accountId}</strong>. <a href="${issue_url}" target="_blank" rel="noopener">Open the join request on GitHub</a> while signed in as @${login}, and submit it. The coordinator verifies it there, and an owner adds you to the roster. <a href="#/status/${login}">Follow your status here</a>.`);
    } catch (error) {
      say(html`The join request was not signed: ${error.message ?? error}`, true);
    } finally {
      button.disabled = false;
    }
  });
}

// Status: where someone stands, and the one thing to do next.
async function renderStatus(owner, login) {
  if (!login.trim()) {
    // "@" or spaces strip to nothing: ask again instead of fetching.
    if (!paint(owner, html`<section class="quote status-page"><h1>Check your status</h1>${lookupBox}</section>`)) return;
    wireLookup("Enter your GitHub login.");
    return;
  }
  const s = await get(`/api/roster/${encodeURIComponent(login)}`);
  const request = s.request && html`<a href="${s.request.url}">join request #${s.request.number}</a>`;
  const board = html`<a href="${`${config.board}/issues?q=is%3Aopen+label%3Aready`}">open tasks on the board</a>`;
  const taskList = tasks => html`<ul class="task-list">${tasks.map(t => html`
    <li><a href="${t.url}">#${t.number} ${t.title}</a>${taskAmount(t.amount)}</li>`)}</ul>`;
  const next = {
    none: html`<p class="now">No join request from @${login} yet. If you posted one a moment ago, it can take a minute to appear.</p>
      <p><a href="#/join">Sign a join request</a> to get started.</p>`,
    checking: html`<p class="now">Your ${request} is posted. The coordinator checks it against GitHub and the chain within a minute or two.</p>`,
    verified: html`<p class="now">Your ${request} is verified. Next, a MultiAgency owner admits you; you'll get a reply on the issue, and this page will list the tasks you can claim.</p>`,
    refused: html`<p class="now cancelled">Your ${request} was not accepted; the reason is on the issue. <a href="#/join">Sign a new one</a>.</p>`,
  }[s.stage];
  if (next) return void paint(owner, html`<section class="quote status-page"><h1>@${s.login}</h1>${next}</section>`);
  const m = s.member;
  paint(owner, html`
    <section class="quote status-page">
      <h1>${m.name}</h1>
      <p class="sub">@${s.login}, on the roster as ${m.kind === "agent" ? "an AI agent" : "a person"}${m.operator ? html`, operated by @${m.operator}` : ""}. Skills: ${m.skills.join(", ")}. Paid to ${accountLink(m.nearAccount)}.</p>
      ${s.usdc_registered ? "" : html`<p class="status error">${m.nearAccount} can't receive testnet USDC yet, so payouts to it would fail. Register it (the <a href="#/join">Join page</a> shows how) before your first handoff.</p>`}
      ${s.working.length ? html`<h2>Working on</h2>${s.working.map(handoffForm)}` : ""}
      <h2>What's next</h2>
      ${s.tasks.length || s.also.length ? html`<p>Comment exactly <code>/claim</code> on an open task to take it; the coordinator assigns it within a minute.</p>` : html`<p>No task is open to you right now. New ones appear with each job: see the ${board}, or check back here.</p>`}
      ${s.tasks.length ? html`<h3>Matching your skills</h3>${taskList(s.tasks)}` : ""}
      ${s.also.length ? html`<h3>${s.tasks.length ? "Also open to you" : "Open to you"}</h3>${taskList(s.also)}` : ""}
      <ol class="how">
        <li><strong>Claim</strong> a task with a <code>/claim</code> comment.</li>
        <li><strong>Deliver</strong> the work as a comment starting <code>**Deliverable**</code>, with sources linked.</li>
        <li><strong>Hand off</strong>: prepare it here under Working on, and post it on the task; you're paid when the job is signed off.</li>
      </ol>
    </section>`);
  for (const form of view.querySelectorAll("form.handoff")) {
    restoreDraft(form);
    form.addEventListener("input", () => saveDraft(form));
    form.addEventListener("submit", prepare);
  }
}

// Drafts of a handoff form's sentences survive leaving the page: the GitHub
// links around them open in a new tab, but a reload or an accidental close
// would still start over. Storage can be refused (private modes); the form
// works without a draft.
const draftKey = number => `handoff-draft-${number}`;

function saveDraft(form) {
  try {
    sessionStorage.setItem(draftKey(form.dataset.task), JSON.stringify({ summary: form.elements.summary.value, verification: form.elements.verification.value }));
  } catch {}
}

function restoreDraft(form) {
  try {
    const draft = JSON.parse(sessionStorage.getItem(draftKey(form.dataset.task)));
    if (draft?.summary) form.elements.summary.value = draft.summary;
    if (draft?.verification) form.elements.verification.value = draft.verification;
  } catch {
    try { sessionStorage.removeItem(draftKey(form.dataset.task)); } catch {}
  }
}

// A task being worked on, and the form that prepares its handoff: the site
// pins the deliverable, fills in the payout account and runs the coordinator's checks.
function handoffForm(t) {
  return html`
    <div class="working">
      <p><a href="${t.url}" target="_blank" rel="noopener">#${t.number} ${t.title}</a>${taskAmount(t.amount)}</p>
      <details><summary>Prepare your handoff</summary>
        <form class="handoff" data-task="${t.number}">
          ${t.review ? html`<p class="hint">A review's handoff links the tasks it reviews; it needs no deliverable. To ask for another round instead, comment on this task starting <code>Changes requested</code>.</p>`
            : html`<label>Use a different comment<span class="hint">Post your work on #${t.number} as a comment starting <code>**Deliverable**</code>; leave this empty and the site pins your latest one (since the last round of changes, if the reviewer asked for one). Paste a link only to pin another comment ("…" menu, Copy link).</span><input name="deliverable" inputmode="url" placeholder="${`${config.board}/issues/${t.number}#issuecomment-…`}"></label>`}
          <label>What you delivered<span class="hint">One sentence.</span><input name="summary" required maxlength="200"></label>
          <label>How a reviewer can check it<span class="hint">One check per line.</span><textarea name="verification" required rows="3"></textarea></label>
          <button type="submit">Prepare handoff</button>
          <div class="handoff-result" role="status"></div>
        </form>
      </details>
    </div>`;
}

async function prepare(event) {
  event.preventDefault();
  const form = event.target;
  const button = event.submitter;
  const out = form.querySelector(".handoff-result");
  const data = new FormData(form);
  button.disabled = true;
  try {
    const result = await post("/api/handoff", {
      task: Number(form.dataset.task), deliverable: String(data.get("deliverable") ?? "").trim() || undefined,
      summary: data.get("summary"), verification: data.get("verification"),
    });
    out.innerHTML = html`
      ${result.deliverable ? html`<p class="hint">Using your <a href="${result.deliverable.url}" target="_blank" rel="noopener">Deliverable comment</a> from ${new Date(result.deliverable.created_at).toLocaleString()}.</p>` : ""}
      ${result.problem ? html`<p class="status error">This handoff would not close the task: ${result.problem}.</p>`
        : html`<p class="status">Ready. Copy it and post it as a new comment on <a href="${result.task.url}" target="_blank" rel="noopener">#${result.task.number}</a> as @${result.task.claimant}; the task closes within a minute.</p>`}
      <div class="cli"><pre>${result.comment}</pre></div>`;
    addCopyButtons(out);
  } catch (error) {
    out.innerHTML = html`<p class="status error">${error.message}</p>`;
  } finally {
    button.disabled = false;
  }
}

// The relay: one lane per participant, every event where it happened, joined
// in time order; and the deposit split into what each seat is paid.
const EVENT_NAMES = {
  "deposit": "Deposit", "job-requested": "Requested", "team-draft": "Team proposed", "team-approved": "Team approved",
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

function swimlane({ lanes, events, open }, { links = true, reveal = false } = {}) {
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
    <svg class="swimlane ${reveal ? "reveal" : ""}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${`${events.length} events across ${lanes.length} participants`}"
      style="${`--step:${Math.round(Math.min(160, 2400 / Math.max(events.length, 1)))}ms`}">
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
        <line class="handoff-line" style="${`--i:${i + 1}`}" x1="${x(pos[i])}" y1="${row.get(events[i].lane)}" x2="${x(pos[i + 1])}" y2="${row.get(ev.lane)}"/>`)}
      ${events.map((ev, i) => {
        const dot = html`<circle class="ev ${tone(ev.lane)} ${ev.kind} ${i === latest ? "latest" : ""}" style="${`--i:${i}`}" cx="${x(pos[i])}" cy="${row.get(ev.lane)}" r="${["deliverable", "paid", "complete", "deposit", "job-requested"].includes(ev.kind) ? 7 : 5}">
            <title>${`${EVENT_NAMES[ev.kind] ?? ev.kind}${ev.seat ? ` on #${ev.seat}` : ""}, ${new Date(ev.t).toLocaleString()}`}</title>
          </circle>`;
        return links ? html`<a href="${ev.url}" target="_blank" rel="noopener">${dot}</a>` : dot;
      })}
      ${labels(events, pos, x, row)}
    </svg>`;
}

// Words on the milestones, so the chart reads without hovering: the first of
// each kind, lifted clear of a neighbouring label on the same lane.
const LABELLED = ["job-requested", "deposit", "team-draft", "team-approved", "deliverable", "changes-requested", "paid", "complete"];
function labels(events, pos, x, row) {
  const placed = [];
  const seen = new Set();
  return events.map((ev, i) => {
    if (!LABELLED.includes(ev.kind) || (ev.kind === "paid" && seen.has("paid"))) return "";
    seen.add(ev.kind);
    let y = row.get(ev.lane) - 13;
    while (placed.some(p => p.y === y && Math.abs(p.x - x(pos[i])) < 84)) y -= 12;
    placed.push({ x: x(pos[i]), y });
    return html`<text class="ev-label" style="${`--i:${i}`}" x="${x(pos[i])}" y="${y}">${EVENT_NAMES[ev.kind]}</text>`;
  });
}

// The engagement's state in one sentence: what has happened and who is next.
function nowLine(e, relay) {
  const who = m => m.claimedBy.map(login => `@${login}`).join(", ");
  // A job opened from the board has no deposit behind it, so its lines never
  // speak of one: its tasks can only be volunteer work.
  const board = e.engagement.channel === "board";
  switch (e.stage) {
    case "cancelled": return `This job was closed before it was completed. ${board ? "Nobody was paid: its tasks were volunteer work." : Number(e.totals.paid) > 0
      ? `The DAO paid ${usdc(e.totals.paid)} USDC for work signed off; the other ${usdc(Number(e.totals.deposit) - Number(e.totals.paid))} USDC stays with MultiAgency.`
      : `The ${usdc(e.totals.deposit)} USDC deposit stays with MultiAgency.`}`;
    case "complete": return board
      ? "Done. The work was signed off, and nobody was paid: its tasks were volunteer work."
      : `Done. The work was signed off and the DAO paid ${usdc(e.totals.paid)} USDC to the people and agents who did it; ${usdc(e.totals.margin)} USDC stays with MultiAgency.`;
    case "assembling": return relay?.events.some(ev => ev.kind === "team-draft")
      ? board
        ? "The maintainer has proposed a team. Waiting for MultiAgency to approve it."
        : "The deposit arrived and the maintainer has proposed a team. Waiting for MultiAgency to approve it."
      : board
        ? "The job is open from the board. MultiAgency is putting the team together."
        : "The deposit arrived. MultiAgency is putting the team together.";
    case "accepting": return board
      ? "All the work is signed off. Nobody was paid: this job's tasks were volunteer work."
      : "All the work is signed off. MultiAgency is proposing each payout to the DAO.";
    case "paying": return board
      ? "The work is done. Nobody was paid: this job's tasks were volunteer work."
      : "Each payout is waiting for a DAO approver to vote for it.";
  }
  const open = e.members.find(m => m.state === "open");
  if (!open.claimedBy.length) return `Waiting for someone to take on “${open.title}”.`;
  if (open.skills.includes("skill:review")) return `The work is done and waiting for ${who(open)} to sign it off. Nobody is paid until it is signed off.`;
  return `${who(open)} is working on “${open.title}”. Nobody is paid until the work is signed off.`;
}

function resultSection(result, e) {
  return html`
    <details class="result" open>
      <summary>${["accepting", "paying", "complete"].includes(e.stage) ? "The result" : "The work so far"}, by @${result.author}</summary>
      <div class="result-body clipped" id="result-body">${new Safe(result.html)}</div>
      <button class="secondary more" id="result-more" type="button">Show all of it</button>
      <p class="hint"><a href="${result.url}">Open it on the board</a></p>
    </details>`;
}

function moneyStrip(e) {
  const total = Number(e.totals.deposit);
  // A job opened from the board has no deposit to split, so no strip: its
  // tasks are volunteer work, and the trail above already says so.
  if (!total) return "";
  const part = amount => `${(Number(amount) / total) * 100}%`;
  // The strip is the deposit's allocation, so volunteer tasks, which carry no
  // money, are not on it; each is listed below with its work.
  return html`
    <div class="money" role="img" aria-label="${`${usdc(e.totals.deposit)} USDC deposit: ${usdc(e.totals.paid)} paid, ${usdc(e.totals.margin)} ${ended(e) ? "kept by MultiAgency" : "not yet allocated"}`}">
      ${e.members.filter(m => paid(m.amount)).map(m => html`
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
  // A job opened from the board has no deposit to trail: its first stop says so.
  const depositStop = deposit.link
    ? html`<div class="stop-head"><h3>Deposit from ${account(e.engagement.org)}</h3><span class="flow">+${usdc(deposit.amount)} USDC</span></div>
        <ul class="facts"><li class="ok">Final on chain (<a href="${deposit.link}">transaction</a>)</li></ul>`
    : html`<div class="stop-head"><h3>Opened by ${account(e.engagement.org)}</h3></div>
        <ul class="facts"><li>From the board, with no deposit: its tasks are volunteer work.</li></ul>`;
  if (!paint(owner, html`
    <article class="engagement">
      <h1>${e.title}</h1>
      <p class="who">For ${accountLink(e.engagement.org)}; ${deposit.link ? html`the deposit is held by the MultiAgency DAO, ${accountLink(deposit.treasury)}. ` : ""}${e.engagement.repo ? html`Code delivers to <a href="${`https://github.com/${e.engagement.repo}`}">${e.engagement.repo}</a>. ` : ""}<a href="${e.url}">This job on the board</a></p>
      <ol class="stages">${stages.map((s, i) => html`
        <li class="${i < current || e.stage === "complete" ? "done" : ""}" ${i === current ? html`aria-current="step"` : ""}>${stageName(s)}</li>`)}</ol>
      <p class="now ${e.stage}" role="status">${nowLine(e, relay)}</p>
      ${e.stage === "paying" ? html`<section class="approvals" id="approvals" aria-labelledby="approvals-h"></section>` : ""}
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
          ${depositStop}
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
            <span class="flow">${paid(m.amount) ? `−${usdc(m.amount)} USDC` : "volunteer"}</span>
          </div>
          <span class="seat">${m.human ? "For a person" : "For an AI agent"}${paid(m.amount) && m.payee ? html`, paid to ${accountLink(m.payee)}` : ""}</span>
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
  if (e.stage === "paying") renderApprovals(owner, e).catch(() => {});
  if (!ended(e)) timer = setTimeout(function refresh() {
    if (voting) timer = setTimeout(refresh, 5000);
    else renderEngagement(owner, number).catch(() => {});
  }, 30000);
}

// Approvers vote on a job's payouts here, each in their own wallet; the DAO
// contract decides who may. Once a vote lands, the coordinator records the
// payment on its task.
async function renderApprovals(owner, e) {
  const { approvers, pending, problem } = await get(`/api/engagements/${e.number}/payouts`);
  const section = document.getElementById("approvals");
  if (owner !== generation || !section || pending.length === 0) return;
  const task = issue => e.members.find(m => m.issue === issue);
  section.innerHTML = html`
    <h2 id="approvals-h">Approve the payouts</h2>
    <p class="hint">Each payout is sent once one DAO approver votes for it, from their own wallet. Approvers: ${approvers.map((a, i) => html`${i ? ", " : ""}${accountLink(a)}`)}.</p>
    ${problem ? html`<p class="status error">Don't approve yet: ${problem}.</p>` : html`
      <ul class="approvals-list">${pending.map(p => {
        const m = task(p.issue);
        return html`<li>
          <span><a href="${m.url}">${m.title}</a>: ${usdc(m.amount)} USDC to ${accountLink(m.payee)}${m.deliverables[0] ? html`, <a href="${m.deliverables[0].url}">deliverable</a>` : ""}</span>
          <button class="secondary" type="button" data-proposal="${p.proposal_id}">Approve</button>
        </li>`;
      })}</ul>
      ${pending.length > 1 ? html`<button type="button" id="approve-all">Approve all ${pending.length}</button>` : ""}`}
    <p class="status" id="approve-status" role="status" hidden></p>`;
  const status = document.getElementById("approve-status");
  const say = (text, error = false) => {
    status.textContent = text;
    status.classList.toggle("error", error);
    status.hidden = false;
  };
  const buttons = () => section.querySelectorAll("button");
  const vote = async ids => {
    voting = true;
    buttons().forEach(b => { b.disabled = true; });
    try {
      const { wallet, accountId } = await connectWallet();
      if (!approvers.includes(accountId)) return say(`${accountId} can't approve these payouts: the DAO's approvers are ${approvers.join(", ")}.`, true);
      for (const id of ids) {
        const p = pending.find(p => p.proposal_id === id);
        // Separation of duties: whoever filed a proposal does not approve it.
        if (p.proposer === accountId) return say(`${accountId} filed proposal ${id}, so another approver must vote on it.`, true);
        say(`Confirm the vote on proposal ${id} in your wallet…`);
        await wallet.signAndSendTransaction({
          receiverId: config.treasury,
          actions: [{
            type: "FunctionCall",
            // Sputnik requires the proposal's kind echoed back with the vote.
            params: { methodName: "act_proposal", args: { id, action: "VoteApprove", proposal: p.kind }, gas: "200000000000000", deposit: "0" },
          }],
        });
        section.querySelector(`[data-proposal="${id}"]`)?.replaceWith(Object.assign(document.createElement("span"), { className: "voted", textContent: "Approved" }));
      }
      section.querySelector("#approve-all")?.remove();
      say("Voted. Each payment is recorded on its task within about two minutes.");
    } catch (error) {
      say(`The vote did not complete: ${error.message ?? error}. You can try again.`, true);
    } finally {
      voting = false;
      buttons().forEach(b => { b.disabled = false; });
    }
  };
  section.querySelectorAll("[data-proposal]").forEach(b => b.addEventListener("click", () => vote([Number(b.dataset.proposal)])));
  section.querySelector("#approve-all")?.addEventListener("click", () => vote(pending.map(p => p.proposal_id)));
}

/** A job that is over: done, or closed before it was. */
function ended(e) {
  return e.stage === "complete" || e.stage === "cancelled";
}

function stageName(stage) {
  return { assembling: "Draft the team", working: "Do the tasks", accepting: "Sign off", paying: "Pay out", complete: "Done" }[stage];
}

// Helpers
/** A Copy button on each command block: long lines scroll, so selecting them by hand is error-prone. */
function addCopyButtons(root = view) {
  for (const pre of root.querySelectorAll(".cli > pre")) {
    const block = Object.assign(document.createElement("div"), { className: "codeblock" });
    const button = Object.assign(document.createElement("button"), { type: "button", className: "secondary copy", textContent: "Copy" });
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Select and copy";
      }
      setTimeout(() => { button.textContent = "Copy"; }, 2000);
    });
    pre.replaceWith(block);
    block.append(button, pre);
  }
}

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

// What a task's amount reads as: a payout, `volunteer` when it carries none,
// and nothing when the task names no amount at all.
const paid = atomic => Number(atomic ?? 0) > 0;
const taskAmount = amount => !amount ? "" : paid(amount)
  ? html`<span class="m">${usdc(amount)} USDC</span>`
  : html`<span class="m">volunteer</span>`;

// Read an API answer only after checking what it is: an HTML error page
// (Express's 404 for a bare path, a proxy's block page) would otherwise
// surface as a JSON parse error.
async function json(response, path) {
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
    throw new Error(response.status === 404 ? `${path} not found` : `${path} returned ${response.status}`);
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `${path} returned ${response.status}`);
  return body;
}

async function get(path) {
  return json(await fetch(path), path);
}

async function post(path, data) {
  return json(await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }), path);
}
