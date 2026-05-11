import express from "express";
import multer from "multer";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024 },
});

const {
  PORT = 4545,
  MEDIA_GATEWAY_TOKEN,
  MEDIA_API_TOKEN,
  RUSTFS_MEDIA_API_URL,
  MEDIA_API_URL,
  MEDIA_GATEWAY_BUCKET = "pindeck",
} = process.env;

const upstreamBaseUrl = String(
  RUSTFS_MEDIA_API_URL || MEDIA_API_URL || "https://media.v1su4.dev"
).replace(/\/+$/, "");
const upstreamToken = MEDIA_API_TOKEN || MEDIA_GATEWAY_TOKEN;

app.use(express.json({ limit: "4mb" }));

function authToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  return req.headers["x-media-gateway-token"] || "";
}

function requireAuth(req, res, next) {
  if (!MEDIA_GATEWAY_TOKEN || authToken(req) !== MEDIA_GATEWAY_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function normalizePath(value) {
  return String(value || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
}

function readBodyTextSafe(response) {
  return response.text().catch(() => "");
}

function toBinaryBody(data) {
  const bytes = Uint8Array.from(data);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function toUpstreamHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${upstreamToken}`,
    ...extra,
  };
}

async function proxyMultipart(endpoint, fields, file) {
  if (!upstreamToken) {
    throw Object.assign(
      new Error("MEDIA_API_TOKEN or MEDIA_GATEWAY_TOKEN is required for RustFS media API writes"),
      { statusCode: 500 }
    );
  }
  if (!file) {
    throw Object.assign(new Error("file required"), { statusCode: 400 });
  }

  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== "") {
      form.append(key, String(value));
    }
  }
  form.append(
    "file",
    new Blob([toBinaryBody(file.buffer)], {
      type: file.mimetype || "application/octet-stream",
    }),
    file.originalname || "upload.bin"
  );

  const response = await fetch(`${upstreamBaseUrl}${endpoint}`, {
    method: "POST",
    headers: toUpstreamHeaders(),
    body: form,
  });
  const body = await readBodyTextSafe(response);
  if (!response.ok) {
    throw Object.assign(
      new Error(`RustFS media API ${endpoint} failed (${response.status}): ${body.slice(0, 300)}`),
      { statusCode: response.status }
    );
  }
  return JSON.parse(body);
}

async function proxyJson(endpoint, payload) {
  if (!upstreamToken) {
    throw Object.assign(
      new Error("MEDIA_API_TOKEN or MEDIA_GATEWAY_TOKEN is required for RustFS media API writes"),
      { statusCode: 500 }
    );
  }
  const response = await fetch(`${upstreamBaseUrl}${endpoint}`, {
    method: "POST",
    headers: toUpstreamHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const body = await readBodyTextSafe(response);
  if (!response.ok) {
    throw Object.assign(
      new Error(`RustFS media API ${endpoint} failed (${response.status}): ${body.slice(0, 300)}`),
      { statusCode: response.status }
    );
  }
  return JSON.parse(body);
}

function sendError(res, error, fallback) {
  console.error(error);
  res.status(error?.statusCode || 500).json({ error: error?.message || fallback });
}

app.post("/upload", requireAuth, upload.single("file"), async (req, res) => {
  try {
    const { userId, folder, bucket } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId required" });
    const payload = await proxyMultipart(
      "/upload",
      { userId, folder, bucket: bucket || MEDIA_GATEWAY_BUCKET },
      req.file
    );
    return res.json(payload);
  } catch (error) {
    return sendError(res, error, "Upload failed");
  }
});

app.post("/import", requireAuth, async (req, res) => {
  try {
    const { sourceUrl, userId, filename, folder, bucket } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId required" });
    if (!sourceUrl) return res.status(400).json({ error: "sourceUrl required" });
    const payload = await proxyJson("/import", {
      sourceUrl,
      userId,
      filename,
      folder,
      bucket: bucket || MEDIA_GATEWAY_BUCKET,
    });
    return res.json(payload);
  } catch (error) {
    return sendError(res, error, "Import failed");
  }
});

app.post("/process-image", requireAuth, upload.single("file"), async (req, res) => {
  try {
    const { userId, folder, basename, originalExt, bucket, title } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId required" });
    if (!folder) return res.status(400).json({ error: "folder required" });
    if (!basename) return res.status(400).json({ error: "basename required" });
    const payload = await proxyMultipart(
      "/process-image",
      {
        userId,
        folder: normalizePath(folder),
        basename,
        originalExt,
        bucket: bucket || MEDIA_GATEWAY_BUCKET,
        title,
      },
      req.file
    );
    return res.json(payload);
  } catch (error) {
    return sendError(res, error, "Image processing failed");
  }
});

app.post("/delete", requireAuth, async (req, res) => {
  try {
    const { bucket, objectKeys } = req.body || {};
    if (!bucket) return res.status(400).json({ error: "bucket required" });
    if (!Array.isArray(objectKeys)) {
      return res.status(400).json({ error: "objectKeys array required" });
    }
    const payload = await proxyJson("/delete", { bucket, objectKeys });
    return res.json(payload);
  } catch (error) {
    return sendError(res, error, "Delete failed");
  }
});

app.get("/health", async (_req, res) => {
  let upstream = null;
  try {
    const response = await fetch(`${upstreamBaseUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    upstream = { ok: response.ok, status: response.status };
  } catch (error) {
    upstream = { ok: false, error: error?.message || "unreachable" };
  }

  res.json({
    ok: true,
    service: "pindeck-media-gateway",
    storageProvider: "rustfs",
    upstreamBaseUrl,
    upstream,
  });
});

app.listen(PORT, () => {
  console.log(`media-gateway compatibility proxy listening on ${PORT}; upstream=${upstreamBaseUrl}`);
});
