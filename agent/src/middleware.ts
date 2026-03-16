import { Request, Response, NextFunction } from "express";
import { log, LITELLM_MASTER_KEY } from "./config";

// Auth middleware — requires Bearer token matching LITELLM_MASTER_KEY
// Skips /health for uptime monitors
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/health" && req.method === "GET") {
    next();
    return;
  }

  const authHeader = (req.headers.authorization ?? "").toString();
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token || token !== LITELLM_MASTER_KEY) {
    log.warn({ path: req.path, ip: req.ip }, "unauthorized request");
    res.status(401).json({ error: "Unauthorized — provide Bearer token in Authorization header" });
    return;
  }

  next();
}

// Rate limiter — sliding window per-endpoint
const windows = new Map<string, number[]>();

export function rateLimiter(maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const timestamps = (windows.get(key) ?? []).filter((t) => now - t < windowMs);

    if (timestamps.length >= maxRequests) {
      const retryAfter = Math.ceil((timestamps[0] + windowMs - now) / 1000);
      log.warn({ path: req.path, ip: req.ip }, "rate limited");
      res.status(429).json({
        error: "Too many requests",
        retry_after_seconds: retryAfter,
      });
      return;
    }

    timestamps.push(now);
    windows.set(key, timestamps);
    next();
  };
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of windows) {
    const active = timestamps.filter((t) => now - t < 300_000);
    if (active.length === 0) windows.delete(key);
    else windows.set(key, active);
  }
}, 300_000).unref();
