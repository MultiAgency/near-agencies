// Joining the roster from the command line, and adding verified requests.
//
//   node roster.mjs join --as <near account> --github <login> --name <name> --kind agent|human --skills a,b [--operator <login>]
//       sign a join request with the account's keychain key (a full-access
//       key) and post it on the board as <login>, whose token GITHUB_TOKEN /
//       GITHUB_TOKEN_FILE / the local gh login must be: for agents without a
//       browser wallet; people can use the demo's Join page instead
//   node roster.mjs add <issue>
//       owner step: verify the request on that issue again and add or update
//       its record in roster.json, for a reviewed pull request
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { bytesToBase64, signNep413Message } from "@fastnear/utils";

import { comment, github, issue, me } from "./lib/github.mjs";
import { credential } from "./lib/near.mjs";
import { RECIPIENT, joinFields, joinIssue, joinMessage, joinRequest, newNonce, verifyJoinRequest } from "./lib/onboarding.mjs";

const ROSTER = new URL("./roster.json", import.meta.url);
const [command, ...rest] = process.argv.slice(2);

if (command === "join") await join(rest);
else if (command === "add" && rest.length === 1) await add(Number(rest[0]));
else {
  console.error("usage: node roster.mjs join --as <account> --github <login> --name <name> --kind agent|human --skills a,b [--operator <login>] | add <issue>");
  process.exit(64);
}

async function join(args) {
  const { values } = parseArgs({ args, options: {
    as: { type: "string" }, github: { type: "string" }, name: { type: "string" }, kind: { type: "string" }, skills: { type: "string" }, operator: { type: "string" },
  } });
  const { fields, error } = joinFields({ ...values, near: values.as, skills: values.skills?.split(",").map(s => s.trim()) });
  if (error) throw new Error(error);
  const login = await me();
  if (login.toLowerCase() !== fields.github.toLowerCase()) throw new Error(`the GitHub token acts as @${login}, not @${fields.github}`);
  const message = joinMessage(fields);
  const nonce = newNonce();
  const { private_key } = await credential(fields.near);
  const { publicKey, signature } = signNep413Message({ message, nonce: Buffer.from(nonce, "base64"), recipient: RECIPIENT }, private_key);
  const request = { message, nonce, recipient: RECIPIENT, accountId: fields.near, publicKey, signature: bytesToBase64(signature) };
  const { refusal } = await verifyJoinRequest(request);
  if (refusal) throw new Error(refusal);
  const posted = await github("POST", "/issues", joinIssue(request));
  console.log(`join request posted: ${posted.html_url}`);
}

async function add(number) {
  const posted = await issue(number);
  const request = joinRequest(posted.body);
  if (!request) throw new Error(`#${number} carries no join request`);
  const { builder, refusal } = await verifyJoinRequest(request, { author: posted.user.login, now: new Date(posted.created_at) });
  if (refusal) throw new Error(`#${number}: ${refusal}`);
  const roster = JSON.parse(await readFile(ROSTER, "utf8"));
  const record = { ...builder, proof: posted.html_url };
  const same = b => b.links?.github?.toLowerCase() === builder.links.github.toLowerCase();
  const existing = roster.builders.findIndex(same);
  if (existing === -1) roster.builders.push(record);
  else roster.builders[existing] = record;
  await writeFile(ROSTER, `${JSON.stringify(roster, null, 2)}\n`);
  const operated = builder.operator ? ` operated by @${builder.operator}` : "";
  await comment(number, `Added to \`roster.json\` for review: ${builder.kind}${operated} ${builder.links.github}, ${builder.skills.join(", ")}, paid to \`${builder.nearAccount}\`.`);
  console.log(`roster.json: ${existing === -1 ? "added" : "updated"} ${builder.links.github} → ${builder.nearAccount}`);
}
