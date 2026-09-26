/* 
 * File intent: Configure Express application, middleware, and routing structure.
 * Adding trust proxy to enable accurate IP detection behind reverse proxies 
 * (like NGINX, HAProxy, AWS ELB, etc) which is important for rate limiting.
 */
import express, { Express } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { authRouter } from "./routes/auth.routes";
import { errorHandler } from "./middlewares/error.middleware";
import { roomRouter } from "./routes/room.routes";
import { publicRouter } from "./routes/public.routes";
import { rateLimitMiddleware } from "./middlewares/rate-limit.middleware";
import { receiveAiResult } from "./controllers/room.controller";

const app: Express = express();

// Trust the GCP Load Balancer / Vercel reverse proxy so that OAuth redirect
// detection and secure-cookie logic see the correct scheme and host.
app.set("trust proxy", 1);

// ── CORS ──────────────────────────────────────────────────────────────────────
// ALLOWED_ORIGINS is a comma-separated list injected at runtime.
// Falls back to localhost patterns for local development.
const productionOrigins: string[] = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const allowedOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow same-machine browser clients (dev) and server-to-server calls.
      if (!origin) {
        callback(null, true);
        return;
      }

      if (allowedOriginPattern.test(origin)) {
        callback(null, true);
        return;
      }

      if (productionOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("CORS origin not allowed"));
    },
    credentials: true,
  }),
);
app.use(rateLimitMiddleware);
// AI image jobs carry a downscaled base64 image (<= ~1.4 MB), so raise the default 100 kb cap.
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

// Internal endpoint for AI worker → HTTP backend callbacks.
// Not rate-limited; guarded by INTERNAL_SECRET header inside the controller.
app.post("/internal/ai/result", receiveAiResult);

//Routes
app.get("/", (_req, res) => res.sendStatus(200));
app.get("/health", (_req, res) => res.sendStatus(200));
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/room", roomRouter);
app.use("/api/v1/public", publicRouter);

app.use(errorHandler);

export default app;
