import { buildApp } from "./app.js";
import { listenAndCloseOnFailure } from "./server-runtime.js";

const app = buildApp();
const port = Number(process.env.PORT ?? 3102);
const host = process.env.HOST ?? "127.0.0.1";

if (!await listenAndCloseOnFailure(app, { port, host })) process.exitCode = 1;
