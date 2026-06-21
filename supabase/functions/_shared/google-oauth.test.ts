// Node-runnable test for the signed-state logic (run: node google-oauth.test.ts).
import { signState, verifyState } from "./google-oauth.ts";

let fail = 0;
const ok = (c: unknown, m: string) => { if (c) console.log("  ok  -", m); else { console.error("  FAIL-", m); fail++; } };

const secret = "test-secret-key-abc123";
const uid = "11111111-2222-3333-4444-555555555555";

const s = await signState(uid, secret, 600);
ok((await verifyState(s, secret)) === uid, "valid state round-trips to userId");
ok((await verifyState(s, "wrong-secret")) === null, "wrong HMAC secret rejected");
ok((await verifyState(s + "x", secret)) === null, "tampered signature rejected");
ok((await verifyState("garbage", secret)) === null, "malformed state rejected");
const expired = await signState(uid, secret, -10);
ok((await verifyState(expired, secret)) === null, "expired state rejected");

console.log(fail ? `\n${fail} FAILED` : "\nstate signing OK ✓");
if (fail) process.exitCode = 1;
