#!/usr/bin/env node
// Offline control-master fixture. It exercises real loopback TCP forwarding but
// deliberately does not implement SSH encryption/authentication.
import net from "node:net";
const args = process.argv.slice(2);
const socket = args[args.indexOf("-S") + 1];
if (args.includes("-O")) {
  const command = args[args.indexOf("-O") + 1];
  const client = net.connect(socket);
  client.on("error", () => {
    console.error("Control socket connect: Connection refused");
    process.exit(1);
  });
  client.on("connect", () =>
    client.write(JSON.stringify({ command, args }) + "\n"),
  );
  client.on("data", (data) => {
    process.exit(data.toString() === "ok" ? 0 : 1);
  });
} else {
  if (args.at(-1) === "fail") process.exit(1);
  if (args.at(-1) === "hang") setInterval(() => {}, 1000);
  else {
    const servers = [];
    net
      .createServer((client) => {
        client.once("data", (data) => {
          const { command, args: callArgs } = JSON.parse(data);
          if (command === "exit") {
            client.end("ok");
            setTimeout(() => process.exit(0), 10);
          } else if (command === "check") client.end("ok");
          else {
            const index = callArgs.findIndex(
              (arg) => arg === "-L" || arg === "-R",
            );
            const [, listen, , target] = callArgs[index + 1].split(":");
            const server = net.createServer((incoming) => {
              const outgoing = net.connect(Number(target), "127.0.0.1");
              outgoing.on("error", () => incoming.destroy());
              incoming.on("error", () => outgoing.destroy());
              incoming.pipe(outgoing).pipe(incoming);
            });
            servers.push(server);
            server.on("error", () => client.end("fail"));
            server.listen(Number(listen), "127.0.0.1", () => client.end("ok"));
          }
        });
      })
      .listen(socket);
  }
}
