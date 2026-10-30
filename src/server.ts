// server.ts — run with: node server.ts
import fs from "node:fs";
import net from "node:net";
import { parseCommand, simple, error, integer, bulk, nullBulk, encodeCommand } from "./resp.ts";

const PORT = 6380;
const AOF_FILE = "appendonly.aof";
let aofFd = -1;
let replaying = false;
const store = new Map<string, string>();
const expiries = new Map<string, number>();

// Appends one command to the log file.
function logCommand(args: string[]): void {
  if (replaying) return;
  fs.writeSync(aofFd, encodeCommand(args));
}

// If the key's deadline has passed, remove it from both maps.
function removeIfExpired(key: string): void {
  if (replaying) return;          
  const expiresAt = expiries.get(key);
  if (expiresAt !== undefined && expiresAt <= Date.now()) {
    store.delete(key);
    expiries.delete(key);
  }
}

// Reads the file and runs every command again to rebuild the data.
function replayAof(): void {
  if (!fs.existsSync(AOF_FILE)) return;      // first run: nothing to replay

  const data = fs.readFileSync(AOF_FILE);
  let offset = 0;                            // how far into the file we are
  let count = 0;

  replaying = true;
  while (offset < data.length) {
    const result = parseCommand(data.subarray(offset));
    if (!result) break;                      // incomplete command at the end
    handle(result.args);                     // run it (no reply is needed)
    offset += result.consumed;
    count++;
  }
  replaying = false;

  sweepExpired();
  console.log(`AOF: replayed ${count} commands, ${store.size} keys loaded`);
}

// Turns one parsed command into a RESP reply string.

function handle(args: string[]): string {
  const [rawName, ...rest] = args;
  const name = (rawName ?? "").toUpperCase();

  switch (name) {
    case "PING": {
      const [message] = rest;
      return message !== undefined ? bulk(message) : simple("POONG");
    }

    case "SET": {
      const [key, value] = rest;
      if (key === undefined || value === undefined)
        return error("ERR wrong number of arguments for 'set'");
      store.set(key, value);
      expiries.delete(key);
      logCommand(["SET", key, value]);
      return simple("OK");
    }

    case "GET": {
      const [key] = rest;
      if (key === undefined || rest.length !== 1)
        return error("ERR wrong number of arguments for 'get'");
      removeIfExpired(key);
      const value = store.get(key);
      return value === undefined ? nullBulk() : bulk(value);
    }

    case "DEL": {
      if (rest.length === 0) return error("ERR wrong number of arguments for 'del'");
      let removed = 0;
      for (const key of rest) {
        removeIfExpired(key);
        if (store.delete(key)) removed++;
        expiries.delete(key);
      }
      if (removed > 0) logCommand(["DEL", ...rest]);
      return integer(removed);
    }

    case "EXPIRE": {
      const [key, secondsText] = rest;
      if (key === undefined || secondsText === undefined || rest.length !== 2)
        return error("ERR wrong number of arguments for 'expire'");

      if (!/^-?\d+$/.test(secondsText))
        return error("ERR value is not an integer or out of range");

      const seconds = Number(secondsText);

      removeIfExpired(key);
      if (!store.has(key)) return integer(0);   // key doesn't exist
      const deadline = Date.now() + seconds * 1000;
      expiries.set(key, deadline);
      logCommand(["PEXPIREAT", key, String(deadline)]);
      return integer(1);                        // deadline saved
    }

    // PEXPIREAT key <unix time in ms> — sets an exact deadline.
    case "PEXPIREAT": {
      const [key, msText] = rest;
      if (key === undefined || msText === undefined || rest.length !== 2)
        return error("ERR wrong number of arguments for 'pexpireat'");
      if (!/^-?\d+$/.test(msText))
        return error("ERR value is not an integer or out of range");

      removeIfExpired(key);
      if (!store.has(key)) return integer(0);

      expiries.set(key, Number(msText));
      logCommand(["PEXPIREAT", key, msText]);
      return integer(1);
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

replayAof();                                  // 1. rebuild the data
aofFd = fs.openSync(AOF_FILE, "a");    
server.listen(PORT, () => console.log(`redis-lite listening on ${PORT}`));

// Every second, delete keys whose deadline has passed (even if nobody reads them).
function sweepExpired(): void {
  const now = Date.now();
  for (const [key, expiresAt] of expiries) {
    if (expiresAt <= now) {
      store.delete(key);
      expiries.delete(key);
    }
  }
}

setInterval(sweepExpired, 1000);