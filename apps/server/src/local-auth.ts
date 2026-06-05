import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

export function createLocalAuthMiddleware(token: string) {
  const tokenBuf = Buffer.from(token);
  return (req: Request, res: Response, next: NextFunction): void => {
    const provided = req.headers["x-pathlight-token"];
    // Length check first — timingSafeEqual requires equal-length buffers.
    // Different lengths leak no secret because token length is public (fixed 32 chars).
    if (typeof provided !== "string" || provided.length !== token.length) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!timingSafeEqual(Buffer.from(provided), tokenBuf)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
}
