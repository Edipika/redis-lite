// server.ts — run with: node server.ts
import net from "node:net";
import { parseCommand, simple, error, integer, bulk, nullBulk } from "./resp.ts";

const PORT = 6380;
const store = new Map<string, string>();

// Turns one parsed command into a RESP reply string.

function handle(args: string[]): string {
  const [rawName, ...rest] = args;
  const name = (rawName ?? "").toUpperCase();

  switch (name) {
    case "PING": {
      const [message] = rest;
      return message !== undefined ? bulk(message) : simple("PONG");
    }

    case "SET": {
      const [key, value] = rest;
      if (key === undefined || value === undefined)
        return error("ERR wrong number of arguments for 'set'");
      store.set(key, value);
      return simple("OK");
    }

    case "GET": {
      const [key] = rest;
      if (key === undefined || rest.length !== 1)
        return error("ERR wrong number of arguments for 'get'");
      const value = store.get(key);
      return value === undefined ? nullBulk() : bulk(value);
    }

    case "DEL": {
      if (rest.length === 0) return error("ERR wrong number of arguments for 'del'");
      let removed = 0;
      for (const key of rest) if (store.delete(key)) removed++;
      return integer(removed);
    }

    // redis-cli sends this on connect; an empty reply keeps it happy.
    case "COMMAND":
      return "*0\r\n";

    default:
      return error(`ERR unknown command '${rawName}'`);
  }
}
const server = net.createServer((socket) => {
  // Each connection gets its own buffer.
  let buffer = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    buffer = Buffer.concat([buffer, bytes]);

    // A chunk may contain zero, one, or many complete commands.
    while (true) {
      let result;
      try {
        result = parseCommand(buffer);
      } catch (e) {
        socket.end(error(`ERR ${(e as Error).message}`));
        return;
      }
      if (!result) break; // incomplete — wait for more data
      buffer = buffer.subarray(result.consumed);
      socket.write(handle(result.args));
    }
  });

  socket.on("error", () => { }); // client disconnected abruptly; ignore
});

server.listen(PORT, () => console.log(`redis-lite listening on ${PORT}`));



// Next step: Day 2, starting with EXPIRE. Here is the plan:

// Add an expiry map. Next to store, add const expiries = new Map<string, number>();. It maps a key to the time (in milliseconds) when it should disappear.
// Add the EXPIRE key seconds command. If the key doesn’t exist, reply integer(0). Otherwise save Date.now() + seconds * 1000 in expiries and reply integer(1). Check that seconds is a valid number.
// Do lazy expiry in GET. Before reading a key, check whether it has an expiry time in the past. If so, delete it from both maps and treat it as missing.
// Add a periodic sweep. Use setInterval every second to look through expiries and delete expired keys, so keys nobody reads don’t pile up.
// Clean up in SET and DEL. A plain SET should remove any old expiry for that key, and DEL should remove it too.
// Test it. Run set a 1, expire a 5, get a (returns "1"), wait 5 seconds, then get a (returns nil).

// After that comes persistence, the append-only log that you replay when the server starts.