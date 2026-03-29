import express from "express";
import { newId } from "../utils/ids";

const REQUEST_ID_HEADER = "x-request-id";

function resolveRequestId(req: express.Request): string {
  const header = req.headers[REQUEST_ID_HEADER];
  if (typeof header === "string" && header.trim().length > 0) {
    return header.trim().slice(0, 120);
  }
  if (Array.isArray(header) && header.length > 0) {
    const first = String(header[0] || "").trim();
    if (first) {
      return first.slice(0, 120);
    }
  }
  return newId();
}

function defaultErrorCode(status: number): string {
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 413) return "payload_too_large";
  if (status === 415) return "unsupported_media_type";
  if (status === 422) return "validation_error";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "internal_error";
  return "request_failed";
}

function normalizeApiErrorBody(
  body: unknown,
  status: number,
  requestId: string
): Record<string, unknown> {
  const fallbackCode = defaultErrorCode(status);

  if (body && typeof body === "object" && !Array.isArray(body)) {
    const source = body as Record<string, unknown>;

    if (source.jsonrpc === "2.0" && source.error && typeof source.error === "object") {
      const rpcError = source.error as Record<string, unknown>;
      const rpcData =
        rpcError.data && typeof rpcError.data === "object"
          ? (rpcError.data as Record<string, unknown>)
          : {};
      return {
        ...source,
        error: {
          ...rpcError,
          data: {
            ...rpcData,
            requestId,
            httpStatus: status
          }
        }
      };
    }

    if (typeof source.error === "string") {
      return {
        ...source,
        code: typeof source.code === "string" ? source.code : fallbackCode,
        status,
        requestId
      };
    }

    if (source.error && typeof source.error === "object") {
      const currentError = source.error as Record<string, unknown>;
      return {
        ...source,
        code:
          typeof source.code === "string"
            ? source.code
            : typeof currentError.code === "string"
              ? currentError.code
              : fallbackCode,
        status,
        requestId
      };
    }

    const message = typeof source.message === "string" ? source.message : "request failed";
    return {
      ...source,
      error: message,
      code: fallbackCode,
      status,
      requestId
    };
  }

  return {
    error: typeof body === "string" ? body : "request failed",
    code: fallbackCode,
    status,
    requestId
  };
}

export function getRequestId(req: express.Request): string {
  const fromLocals = req.res?.locals?.requestId;
  if (typeof fromLocals === "string" && fromLocals.length > 0) {
    return fromLocals;
  }
  return resolveRequestId(req);
}

export function createApiResponseMiddleware(): express.RequestHandler {
  return (req, res, next) => {
    const requestId = resolveRequestId(req);
    res.locals.requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);

    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode >= 400) {
        const payload = normalizeApiErrorBody(body, res.statusCode, requestId);
        return originalJson(payload);
      }
      return originalJson(body);
    };

    next();
  };
}

export function createApiJsonParseErrorHandler(): express.ErrorRequestHandler {
  return (error, req, res, next) => {
    const isSyntaxError = error instanceof SyntaxError;
    const hasBody = typeof (error as { body?: unknown })?.body !== "undefined";
    if (!isSyntaxError || !hasBody || !req.path.startsWith("/api")) {
      next(error);
      return;
    }

    const requestId = typeof res.locals.requestId === "string" && res.locals.requestId
      ? res.locals.requestId
      : resolveRequestId(req);
    res.locals.requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);

    res.status(400).json({
      error: "invalid JSON body",
      code: "invalid_json",
      status: 400,
      requestId
    });
  };
}
