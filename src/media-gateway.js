import express from "express";
import multer from "multer";
import crypto from "crypto";
import sharp from "sharp";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024 },
});

const trimTrailingSlash = (value) => String(value || "").replace(/\/+$/, "");

const normalizePath = (value) =>
  String(value || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");

const deriveNextcloudBaseUrl = (value) => {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    const remotePhpIndex = parsed.pathname.indexOf("/remote.php/");
    const basePath =
      remotePhpIndex >= 0 ? parsed.pathname.slice(0, remotePhpIndex) : parsed.pathname;
    return trimTrailingSlash(`${parsed.origin}${basePath}`);
  } catch {
    return trimTrailingSlash(value);
  }
};

const {
  PORT = 4545,
  MEDIA_GATEWAY_TOKEN,
  NEXTCLOUD_URL: NEXTCLOUD_URL_RAW,
  NEXTCLOUD_USERNAME: NEXTCLOUD_USERNAME_RAW,
  NEXTCLOUD_PASSWORD: NEXTCLOUD_PASSWORD_RAW,
  NEXTCLOUD_WEBDAV_BASE_URL,
  NEXTCLOUD_WEBDAV_USER,
  NEXTCLOUD_WEBDAV_APP_PASSWORD,
  NEXTCLOUD_BASE_FOLDER,
  NEXTCLOUD_UPLOAD_PREFIX,
  NEXTCLOUD_PUBLIC_BASE_URL,
  NEXTCLOUD_PUBLIC_SHARE_TOKEN,
  NEXTCLOUD_PUBLIC_SHARE_PATH,
} = process.env;

const NEXTCLOUD_URL =
  NEXTCLOUD_URL_RAW || deriveNextcloudBaseUrl(NEXTCLOUD_WEBDAV_BASE_URL);
const NEXTCLOUD_USERNAME = NEXTCLOUD_USERNAME_RAW || NEXTCLOUD_WEBDAV_USER;
const NEXTCLOUD_PASSWORD = NEXTCLOUD_PASSWORD_RAW || NEXTCLOUD_WEBDAV_APP_PASSWORD;
const RESOLVED_NEXTCLOUD_BASE_FOLDER =
  NEXTCLOUD_BASE_FOLDER || NEXTCLOUD_UPLOAD_PREFIX || "/pindeck/media-uploads";

const VARIANTS = {
  preview: { width: 640, height: 360, suffix: "preview", quality: 78 },
  small: { width: 320, height: 180, suffix: "w320", quality: 78 },
  medium: { width: 1280, height: 720, suffix: "w1280", quality: 82 },
  large: { width: 1920, height: 1080, suffix: "w1920", quality: 84 },
};

if (!MEDIA_GATEWAY_TOKEN) {
  console.warn("MEDIA_GATEWAY_TOKEN is not set");
}
if (!NEXTCLOUD_URL || !NEXTCLOUD_USERNAME || !NEXTCLOUD_PASSWORD) {
  console.warn("Nextcloud credentials are not fully set");
}

app.use(express.json({ limit: "2mb" }));

const encodePath = (value) =>
  normalizePath(value)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

const authHeader = (req) => {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  return req.headers["x-media-gateway-token"] || "";
};

const requireAuth = (req, res, next) => {
  if (!MEDIA_GATEWAY_TOKEN || authHeader(req) !== MEDIA_GATEWAY_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

const nextcloudBaseUrl = trimTrailingSlash(NEXTCLOUD_URL);
const nextcloudPublicBaseUrl = trimTrailingSlash(
  NEXTCLOUD_PUBLIC_BASE_URL || NEXTCLOUD_URL
);

const authHeaders = () => ({
  Authorization:
    "Basic " +
    Buffer.from(`${NEXTCLOUD_USERNAME}:${NEXTCLOUD_PASSWORD}`).toString("base64"),
});

const toWebdavUrl = (path) =>
  `${nextcloudBaseUrl}/remote.php/dav/files/${encodeURIComponent(
    NEXTCLOUD_USERNAME
  )}/${encodePath(path)}`;

const toOcsUrl = () =>
  `${nextcloudBaseUrl}/ocs/v2.php/apps/files_sharing/api/v1/shares`;

const safeFilename = (name, fallbackExt = "png") => {
  const base = String(name || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
  if (base.includes(".")) return base;
  return `${base}.${fallbackExt}`;
};

const rootSharePath = normalizePath(
  NEXTCLOUD_PUBLIC_SHARE_PATH || RESOLVED_NEXTCLOUD_BASE_FOLDER
);

const buildPublicUrl = (path) => {
  const normalized = normalizePath(path);
  if (!NEXTCLOUD_PUBLIC_SHARE_TOKEN || !rootSharePath) {
    return null;
  }
  if (normalized !== rootSharePath && !normalized.startsWith(`${rootSharePath}/`)) {
    return null;
  }
  const relative = normalized === rootSharePath ? "" : normalized.slice(rootSharePath.length + 1);
  if (!relative) return null;
  return `${nextcloudPublicBaseUrl}/public.php/dav/files/${encodeURIComponent(
    NEXTCLOUD_PUBLIC_SHARE_TOKEN
  )}/${encodePath(relative)}`;
};

const ensureFolder = async (folderPath) => {
  const parts = normalizePath(folderPath).split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const res = await fetch(toWebdavUrl(current), {
      method: "MKCOL",
      headers: authHeaders(),
    });
    if (![201, 301, 302, 403, 405].includes(res.status)) {
      const text = await res.text().catch(() => "");
      throw new Error(`MKCOL failed (${res.status}): ${text.slice(0, 200)}`);
    }
  }
};

const shareFile = async (path) => {
  const res = await fetch(toOcsUrl(), {
    method: "POST",
    headers: {
      ...authHeaders(),
      "OCS-APIRequest": "true",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      path: `/${normalizePath(path)}`,
      shareType: "3",
      permissions: "1",
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OCS share failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const urlMatch = text.match(/<url>([^<]+)<\/url>/);
  const shareUrl = urlMatch ? urlMatch[1] : null;
  if (!shareUrl) {
    throw new Error("OCS share response missing public URL");
  }
  return `${shareUrl.replace(/\/$/, "")}/download`;
};

const uploadBuffer = async (path, contentType, buffer) => {
  await ensureFolder(normalizePath(path).split("/").slice(0, -1).join("/"));

  const uploadRes = await fetch(toWebdavUrl(path), {
    method: "PUT",
    headers: {
      ...authHeaders(),
      "Content-Type": contentType || "application/octet-stream",
    },
    body: buffer,
  });

  if (!uploadRes.ok) {
    const text = await uploadRes.text().catch(() => "");
    throw new Error(`Upload failed (${uploadRes.status}): ${text.slice(0, 300)}`);
  }

  return buildPublicUrl(path) || (await shareFile(path));
};

const buildBaseName = (value) =>
  String(value || "image")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "image";

const createVariantBuffer = (buffer, { width, height, quality }) =>
  sharp(buffer)
    .rotate()
    .trim({ threshold: 10 })
    .resize({
      width,
      height,
      fit: "cover",
      position: "attention",
      withoutEnlargement: false,
    })
    .webp({ quality })
    .toBuffer();

app.post("/upload", requireAuth, upload.single("file"), async (req, res) => {
  try {
    const { userId, folder } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId required" });
    if (!req.file) return res.status(400).json({ error: "file required" });

    const now = new Date();
    const yyyyMm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const baseFolder =
      normalizePath(folder) ||
      normalizePath(`${RESOLVED_NEXTCLOUD_BASE_FOLDER}/${userId}/${yyyyMm}`);
    const filename = safeFilename(
      req.file.originalname,
      req.file.mimetype.split("/")[1] || "png"
    );
    const path = `${baseFolder}/${Date.now()}-${filename}`;
    const publicUrl = await uploadBuffer(path, req.file.mimetype, req.file.buffer);

    return res.json({
      publicUrl,
      path: normalizePath(path),
      mime: req.file.mimetype,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error?.message || "Upload failed" });
  }
});

app.post("/import", requireAuth, async (req, res) => {
  try {
    const { sourceUrl, userId, filename, folder } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId required" });
    if (!sourceUrl) return res.status(400).json({ error: "sourceUrl required" });

    const response = await fetch(sourceUrl);
    if (!response.ok) {
      return res
        .status(400)
        .json({ error: `Failed to fetch sourceUrl: ${response.status}` });
    }

    const contentType = response.headers.get("content-type") || "image/png";
    const buffer = Buffer.from(await response.arrayBuffer());
    const now = new Date();
    const yyyyMm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const baseFolder =
      normalizePath(folder) ||
      normalizePath(`${RESOLVED_NEXTCLOUD_BASE_FOLDER}/${userId}/${yyyyMm}`);
    const ext = contentType.split("/")[1] || "png";
    const resolvedName =
      filename || `import-${crypto.randomBytes(6).toString("hex")}.${ext}`;
    const path = `${baseFolder}/${Date.now()}-${safeFilename(resolvedName, ext)}`;
    const publicUrl = await uploadBuffer(path, contentType, buffer);

    return res.json({
      publicUrl,
      path: normalizePath(path),
      mime: contentType,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error?.message || "Import failed" });
  }
});

app.post("/process-image", requireAuth, upload.single("file"), async (req, res) => {
  try {
    const { userId, folder, basename, originalExt, title } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId required" });
    if (!req.file) return res.status(400).json({ error: "file required" });

    const now = new Date();
    const yyyy = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    const day = String(now.getUTCDate()).padStart(2, "0");
    const monthDay = `${month}_${day}`;
    const resolvedFolder =
      normalizePath(folder) ||
      normalizePath(`${NEXTCLOUD_BASE_FOLDER}/${yyyy}/${monthDay}`);
    const ext =
      String(originalExt || "").replace(/^\./, "") ||
      req.file.mimetype.split("/")[1] ||
      "png";
    const fileBase =
      buildBaseName(basename || title || req.file.originalname) +
      `-${crypto.randomBytes(3).toString("hex")}`;

    const originalPath = `${resolvedFolder}/original/${safeFilename(`${fileBase}.${ext}`)}`;
    const previewPath = `${resolvedFolder}/preview/${fileBase}-preview.webp`;
    const smallPath = `${resolvedFolder}/low/${fileBase}-${VARIANTS.small.suffix}.webp`;
    const mediumPath = `${resolvedFolder}/high/${fileBase}-${VARIANTS.medium.suffix}.webp`;
    const largePath = `${resolvedFolder}/high/${fileBase}-${VARIANTS.large.suffix}.webp`;

    const [previewBuffer, smallBuffer, mediumBuffer, largeBuffer] = await Promise.all([
      createVariantBuffer(req.file.buffer, VARIANTS.preview),
      createVariantBuffer(req.file.buffer, VARIANTS.small),
      createVariantBuffer(req.file.buffer, VARIANTS.medium),
      createVariantBuffer(req.file.buffer, VARIANTS.large),
    ]);

    const [
      imageUrl,
      previewUrl,
      smallUrl,
      mediumUrl,
      largeUrl,
    ] = await Promise.all([
      uploadBuffer(originalPath, req.file.mimetype, req.file.buffer),
      uploadBuffer(previewPath, "image/webp", previewBuffer),
      uploadBuffer(smallPath, "image/webp", smallBuffer),
      uploadBuffer(mediumPath, "image/webp", mediumBuffer),
      uploadBuffer(largePath, "image/webp", largeBuffer),
    ]);

    return res.json({
      imageUrl,
      previewUrl,
      storagePath: originalPath,
      previewStoragePath: previewPath,
      derivativeUrls: {
        small: smallUrl,
        medium: mediumUrl,
        large: largeUrl,
      },
      derivativeStoragePaths: {
        small: smallPath,
        medium: mediumPath,
        large: largePath,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error?.message || "Image processing failed" });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "pindeck-media-gateway" });
});

app.listen(PORT, () => {
  console.log(`media-gateway listening on ${PORT}`);
});
