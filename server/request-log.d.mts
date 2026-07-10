import type { NextFunction, Request, Response } from "express";

export function safeRequestPath(requestTarget: string): string;

export function formatRequestLog(input: {
  durationMs: number;
  method: string;
  requestTarget: string;
  status: number;
}): string;

export function requestLogger(
  request: Request,
  response: Response,
  next: NextFunction,
): void;
