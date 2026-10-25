// Starts the ChatChing server. Run: npm start (stop it with Ctrl+C).
// All the real work is in src/app.js, so the tests can start the same app on a free port.
import { loadConfig } from "./src/config.js";
import { createApp } from "./src/app.js";

function main() {
  const config = loadConfig();
  for (const warning of config.warnings) console.log(`Warning: ${warning}`);

  const app = createApp(config);
  const server = app.listen(config.port);

  server.on("listening", () => {
    const keys = Object.entries(config.keysPresent).map(([name, present]) => `${name}=${present ? "yes" : "no"}`);
    console.log(`ChatChing is running at http://localhost:${server.address().port}`);
    console.log(`AI mode: ${config.aiMode}. Keys present: ${keys.join(", ")}`);
  });

  server.on("error", (err) => {
    console.log(
      err.code === "EADDRINUSE"
        ? `Port ${config.port} is already in use. Stop the other server first, or set PORT to another number.`
        : `The server could not start: ${err.message}`,
    );
    process.exitCode = 1;
  });
}

try {
  main();
} catch (err) {
  console.log(`ChatChing could not start: ${err.message}`);
  process.exitCode = 1;
}
