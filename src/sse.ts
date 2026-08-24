// Incremental server-sent-events parser shared by the daemon's unix-socket
// subscriber and the cross-host `am __events` pipe reader. Feed raw text
// chunks as they arrive; each complete event block's data payload (the
// concatenated `data:` lines) is delivered once. Comment-only blocks
// (keepalives) carry no data and are skipped.
export function createSseParser(onData: (data: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) return;
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) onData(data);
    }
  };
}
