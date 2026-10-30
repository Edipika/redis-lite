// resp.ts — parse incoming RESP commands and encode replies.

// A parsed command, plus how many bytes of the buffer it used up.
// null means "not enough bytes yet — wait for more data".
export type ParseResult = { args: string[]; consumed: number } | null;

const CRLF = "\r\n";

// Reads one line starting at `start` (without the \r\n).
// Returns the line text and the index just after the \r\n, or null if
// the line isn't complete yet.
function readLine(buf: Buffer, start: number): { line: string; next: number } | null {
  const end = buf.indexOf(CRLF, start);
  if (end === -1) return null; // \r\n hasn't arrived yet
  return { line: buf.toString("utf8", start, end), next: end + 2 };
}

export function parseCommand(buf: Buffer): ParseResult {
  if (buf.length === 0) return null;

  // Every command from redis-cli is an array: *<count>\r\n
  if (buf[0] !== 0x2a /* '*' */) {
    throw new Error("Protocol error: expected '*'");
  }

  const header = readLine(buf, 1);
  if (!header) return null;
  const count = Number(header.line);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error("Protocol error: invalid array length");
  }

  let pos = header.next;
  const args: string[] = [];

  for (let i = 0; i < count; i++) {
    // Each element is a bulk string: $<len>\r\n<bytes>\r\n
    if (pos >= buf.length) return null;
    if (buf[pos] !== 0x24 /* '$' */) {
      throw new Error("Protocol error: expected '$'");
    }

    const lenLine = readLine(buf, pos + 1);
    if (!lenLine) return null;
    const len = Number(lenLine.line);
    if (!Number.isInteger(len) || len < 0) {
      throw new Error("Protocol error: invalid bulk length");
    }

    // Do we have all `len` bytes plus the trailing \r\n?
    const dataStart = lenLine.next;
    const dataEnd = dataStart + len;
    if (dataEnd + 2 > buf.length) return null;

    // Slice by BYTE length — never search for \r\n inside the data,
    // because the value itself may contain \r\n.
    args.push(buf.toString("utf8", dataStart, dataEnd));
    pos = dataEnd + 2;
  }

  return { args, consumed: pos };
}

// ---- Reply encoders: the 5 reply types we need ----

export const simple = (s: string) => `+${s}\r\n`;
export const error = (msg: string) => `-${msg}\r\n`;
export const integer = (n: number) => `:${n}\r\n`;
export const nullBulk = () => `$-1\r\n`;
export const bulk = (s: string) => `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
export const encodeCommand = (args: string[]) =>
  `*${args.length}\r\n` + args.map(bulk).join("");