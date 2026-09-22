const USER_AGENT = "PEREX-Noon-Manager/1.0";
const MAX_REPORT_BYTES = 15 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const ALLOWED_DOWNLOAD_HOSTS = [
  "storage.googleapis.com",
  "storage.cloud.google.com",
];

export default {
  async fetch(request, env) {
    try {
      if (request.method !== "GET") {
        return json({ error: "method_not_allowed" }, 405, {
          Allow: "GET",
        });
      }

      const url = new URL(request.url);

      if (url.pathname.startsWith("/images/")) {
        return serveProductImage(request, url);
      }

      if (!env.WORKER_TOKEN) {
        throw new HttpError(500, "WORKER_TOKEN is not configured");
      }

      const suppliedToken = request.headers
        .get("Authorization")
        ?.replace(/^Bearer\s+/i, "");

      if (
        !suppliedToken ||
        !constantTimeEqual(suppliedToken, env.WORKER_TOKEN)
      ) {
        return json({ error: "unauthorized" }, 401, {
          "WWW-Authenticate": "Bearer",
        });
      }

      const expectedPath =
        `/reports/${encodeURIComponent(env.NOON_REPORT_CODE)}` +
        `/products/${encodeURIComponent(env.TARGET_PARTNER_SKU)}`;

      if (url.pathname !== expectedPath) {
        return json({
          error: "not_found",
          expected_path: expectedPath,
        }, 404);
      }

      validateConfiguration(env);

      const cookie = await loginToNoon(env);
      const report = await getCompletedReport(env, cookie);
      const downloaded = await downloadReport(report.download_url);
      const rows = parseReport(downloaded.bytes, downloaded.contentType);
      const product = findProduct(rows, env.TARGET_PARTNER_SKU);

      if (!product) {
        return json({
          report_code: env.NOON_REPORT_CODE,
          partner_sku: env.TARGET_PARTNER_SKU,
          found: false,
        }, 404);
      }

      return json({
        report_code: env.NOON_REPORT_CODE,
        report_status: report.export_status,
        partner_sku: env.TARGET_PARTNER_SKU,
        found: true,
        product,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));

      const status = error instanceof HttpError ? error.status : 500;
      const message =
        error instanceof HttpError ? error.message : "internal_error";

      return json({ error: message }, status);
    }
  },
};

function validateConfiguration(env) {
  const required = [
    "NOON_BASE_URL",
    "NOON_REPORT_CODE",
    "TARGET_PARTNER_SKU",
    "NOON_KEY_ID",
    "NOON_PRIVATE_KEY",
    "NOON_PROJECT_CODE",
  ];

  for (const name of required) {
    if (!env[name]) {
      throw new HttpError(500, `${name} is not configured`);
    }
  }

  if (env.NOON_REPORT_CODE !== "EXP4E2HD6HA4") {
    throw new HttpError(500, "Unexpected report code");
  }

  if (env.TARGET_PARTNER_SKU !== "159-BRD340") {
    throw new HttpError(500, "Unexpected target SKU");
  }

  const baseUrl = new URL(env.NOON_BASE_URL);

  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.hostname !== "noon-api-gateway.noon.partners"
  ) {
    throw new HttpError(500, "Invalid NOON_BASE_URL");
  }
}

async function serveProductImage(request, url) {
  const match = url.pathname.match(
    /^\/images\/([A-Za-z0-9_-]{10,128})\.jpg$/,
  );

  if (!match) {
    return json({ error: "invalid_image_path" }, 400);
  }

  const cache = caches.default;
  const cached = await cache.match(request);

  if (cached) {
    return cached;
  }

  const driveUrl =
    `https://drive.google.com/uc?export=download&id=` +
    encodeURIComponent(match[1]);

  const sourceUrl = new URL("https://wsrv.nl/");
  sourceUrl.searchParams.set("url", driveUrl);
  sourceUrl.searchParams.set("output", "jpg");
  sourceUrl.searchParams.set("q", "90");

  const response = await fetch(sourceUrl, {
    method: "GET",
    redirect: "follow",
    headers: {
      Accept: "image/jpeg",
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new HttpError(
      502,
      `Image source failed with HTTP ${response.status}`,
    );
  }

  const contentType = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    ?.toLowerCase();

  if (contentType !== "image/jpeg") {
    throw new HttpError(502, "Image source did not return JPEG");
  }

  const declaredLength = Number(
    response.headers.get("content-length") || 0,
  );

  if (declaredLength > MAX_IMAGE_BYTES) {
    throw new HttpError(413, "Image is too large");
  }

  const bytes = await readLimitedBody(response, MAX_IMAGE_BYTES);

  const result = new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
    },
  });

  await cache.put(request, result.clone());
  return result;
}

async function loginToNoon(env) {
  const jwt = await createJwt(
    env.NOON_KEY_ID,
    env.NOON_PRIVATE_KEY,
  );

  const loginUrl = new URL(
    "/identity/public/v1/api/login",
    env.NOON_BASE_URL,
  );

  const response = await fetch(loginUrl, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      token: jwt,
      default_project_code: env.NOON_PROJECT_CODE,
    }),
  });

  if (!response.ok) {
    throw new HttpError(
      502,
      `Noon authentication failed with HTTP ${response.status}`,
    );
  }

  const setCookie = response.headers.get("set-cookie");

  if (!setCookie) {
    throw new HttpError(
      502,
      "Noon authentication returned no session",
    );
  }

  const cookie = setCookie.split(";")[0]?.trim();

  if (!cookie || !cookie.includes("=")) {
    throw new HttpError(502, "Invalid Noon session cookie");
  }

  return cookie;
}

async function getCompletedReport(env, cookie) {
  const statusUrl = new URL(
    "/impex/v1/export/status",
    env.NOON_BASE_URL,
  );

  const response = await fetch(statusUrl, {
    method: "POST",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: cookie,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      export_code: env.NOON_REPORT_CODE,
    }),
  });

  if (!response.ok) {
    throw new HttpError(
      502,
      `Report lookup failed with HTTP ${response.status}`,
    );
  }

  const report = await response.json();

  if (report.export_code !== env.NOON_REPORT_CODE) {
    throw new HttpError(
      502,
      "Noon returned a different report",
    );
  }

  const status = String(
    report.export_status || "",
  ).toUpperCase();

  if (
    !["COMPLETED", "COMPLETE", "DONE", "SUCCESS"].includes(status)
  ) {
    throw new HttpError(
      409,
      `Report is not completed: ${status || "UNKNOWN"}`,
    );
  }

  if (!report.download_url) {
    throw new HttpError(
      502,
      "Completed report has no download URL",
    );
  }

  return report;
}

async function downloadReport(rawUrl) {
  const url = new URL(rawUrl);

  if (url.protocol !== "https:") {
    throw new HttpError(
      502,
      "Report download must use HTTPS",
    );
  }

  const hostAllowed =
    ALLOWED_DOWNLOAD_HOSTS.includes(url.hostname) ||
    url.hostname.endsWith(".storage.googleapis.com");

  if (!hostAllowed) {
    throw new HttpError(
      502,
      "Report download host is not allowed",
    );
  }

  if (url.username || url.password) {
    throw new HttpError(
      502,
      "Credentials in download URL are forbidden",
    );
  }

  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    headers: {
      Accept:
        "text/csv, text/tab-separated-values, application/json",
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new HttpError(
      502,
      `Report download failed with HTTP ${response.status}`,
    );
  }

  const declaredLength = Number(
    response.headers.get("content-length") || 0,
  );

  if (declaredLength > MAX_REPORT_BYTES) {
    throw new HttpError(413, "Report is too large");
  }

  const bytes = await readLimitedBody(
    response,
    MAX_REPORT_BYTES,
  );

  return {
    bytes,
    contentType:
      response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        ?.toLowerCase() || "",
  };
}

async function readLimitedBody(response, limit) {
  if (!response.body) {
    throw new HttpError(
      502,
      "Report response has no body",
    );
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > limit) {
      await reader.cancel();
      throw new HttpError(413, "Report is too large");
    }

    chunks.push(value);
  }

  const output = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

function parseReport(bytes, contentType) {
  const text = new TextDecoder("utf-8", {
    fatal: true,
  })
    .decode(bytes)
    .replace(/^\uFEFF/, "");

  if (
    contentType === "application/json" ||
    /^[\s]*[\[{]/.test(text)
  ) {
    const parsed = JSON.parse(text);

    const rows = Array.isArray(parsed)
      ? parsed
      : parsed.items || parsed.rows || parsed.data;

    if (!Array.isArray(rows)) {
      throw new HttpError(
        502,
        "Unsupported JSON report structure",
      );
    }

    return rows;
  }

  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const delimiter = firstLine.includes("\t") ? "\t" : ",";

  return parseDelimited(text, delimiter);
}

function parseDelimited(text, delimiter) {
  const matrix = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }

      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      matrix.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (quoted) {
    throw new HttpError(
      502,
      "Malformed quoted field in report",
    );
  }

  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    matrix.push(row);
  }

  const nonEmptyRows = matrix.filter((values) =>
    values.some((value) => value.trim() !== ""),
  );

  if (nonEmptyRows.length < 2) {
    throw new HttpError(
      502,
      "Report contains no product rows",
    );
  }

  const headers = nonEmptyRows[0].map(normalizeHeader);

  if (new Set(headers).size !== headers.length) {
    throw new HttpError(
      502,
      "Report contains duplicate columns",
    );
  }

  return nonEmptyRows.slice(1).map((values) =>
    Object.fromEntries(
      headers.map((header, index) => [
        header,
        values[index] ?? "",
      ]),
    ),
  );
}

function findProduct(rows, targetSku) {
  const preferredColumns = [
    "partner_sku",
    "partner_sku_code",
    "seller_sku",
    "sku",
    "psku",
    "psku_code",
  ];

  for (const row of rows) {
    for (const column of preferredColumns) {
      if (
        Object.hasOwn(row, column) &&
        String(row[column]).trim() === targetSku
      ) {
        return row;
      }
    }
  }

  return null;
}

async function createJwt(keyId, privateKeyPem) {
  const header = base64Url(
    new TextEncoder().encode(
      JSON.stringify({
        alg: "RS256",
        typ: "JWT",
      }),
    ),
  );

  const payload = base64Url(
    new TextEncoder().encode(
      JSON.stringify({
        sub: keyId,
        iat: Math.floor(Date.now() / 1000),
        jti: crypto.randomUUID(),
      }),
    ),
  );

  const signingInput = `${header}.${payload}`;

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(privateKeyPem),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );

  return (
    `${signingInput}.` +
    base64Url(new Uint8Array(signature))
  );
}

function pemToBytes(pem) {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");

  if (!base64) {
    throw new HttpError(
      500,
      "Invalid Noon private key",
    );
  }

  const binary = atob(base64);

  return Uint8Array.from(
    binary,
    (char) => char.charCodeAt(0),
  );
}

function base64Url(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function normalizeHeader(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function constantTimeEqual(left, right) {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;

  for (let index = 0; index < length; index += 1) {
    difference |=
      (a[index] || 0) ^ (b[index] || 0);
  }

  return difference === 0;
}

function json(body, status = 200, headers = {}) {
  return new Response(
    JSON.stringify(body, null, 2),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...headers,
      },
    },
  );
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
