import { buildApp } from "./app.js";

const port = Number(process.env["PORT"] ?? 3000);

const app = buildApp();

// 0.0.0.0 is container-internal only; compose maps it to 127.0.0.1 on the
// host. No public ports — Hard Invariant 6.
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err, "concierge failed to start");
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    process.exit(0);
  });
}
