// Client for Lab 3. Sends three requests and shows why message history matters.
//   bun run labs/openai/03-client.ts            (server must be running on :3456)
export {};
const BASE = process.env.BASE ?? "http://localhost:3456";

async function chat(label: string, prompt: string, messages: unknown[] = []) {
  console.log(`\n### ${label}`);
  console.log(`> ${prompt}   (sending ${messages.length} history messages)`);
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, messages }),
  });
  const data: any = await res.json();
  if (data.error) {
    console.log("server error:", data.error);
    return data;
  }
  console.log("model:", data.text);
  for (const b of data.blocked ?? []) console.log("BLOCKED:", b);
  console.log("gate state:", String(data.status).replace(/\n/g, " | "));
  return data;
}

const health = await (await fetch(`${BASE}/`)).json();
console.log("server:", JSON.stringify(health));

// Request 1: run the tests. The session for this request ends with the response.
const r1 = await chat("Request 1", "Run the tests.");

// Request 2: deploy WITH the history from request 1.
// Replay sees the successful test, so deploy is allowed.
await chat("Request 2 (with history)", "Deploy version v1.", r1.messages);

// Request 3: deploy WITHOUT history.
// A fresh session has never seen a test, so deploy is blocked.
await chat("Request 3 (no history)", "Deploy version v1.");

console.log("\nLesson: the server keeps nothing between requests. "
  + "The chat history is the gate's memory.");
