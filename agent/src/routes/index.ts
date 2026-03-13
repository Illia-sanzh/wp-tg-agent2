import express from "express";
import { notifyError } from "../notify";
import { coreRouter } from "./core";
import { adminRouter } from "./admin";

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(coreRouter);
  app.use(adminRouter);

  app.use((err: any, _req: any, res: any, _next: any) => {
    notifyError("express", err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
